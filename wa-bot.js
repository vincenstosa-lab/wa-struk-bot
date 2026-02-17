/* ================= SAFE GUARD ================= */
process.on('uncaughtException', err => console.error('❌ Uncaught:', err))
process.on('unhandledRejection', err => console.error('❌ Rejection:', err))

/* ================= IMPORT ================= */
const express = require('express')
const QRCode = require('qrcode')
const crypto = require('crypto')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys')

const Pino = require('pino')
const fs = require('fs')
const path = require('path')
const Tesseract = require('tesseract.js')
const sharp = require('sharp')
const { GoogleSpreadsheet } = require('google-spreadsheet')

/* ================= CONFIG ================= */
const AUTH_DIR = '/data/auth'
const IMAGE_DIR = '/data/images'
const MEMORY_FILE = '/data/merchant_memory.json'
const SHEET_ID = '1qjSndza2fwNhkQ6WzY9DGhunTHV7cllbs75dnG5I6r4'

for (const d of [AUTH_DIR, IMAGE_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

/* ================= MEMORY ================= */

let merchantMemory = {}
let receiptHashes = new Set()

if (fs.existsSync(MEMORY_FILE)) {
  merchantMemory = JSON.parse(fs.readFileSync(MEMORY_FILE))
}

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(merchantMemory, null, 2))
}

/* ================= HTTP ================= */

const app = express()
let latestQR = null

app.get('/', (_, res) => res.send('✅ AI Expense Engine running'))
app.get('/qr', async (_, res) => {
  if (!latestQR) return res.send('QR belum ada')
  res.send(`<img src="${await QRCode.toDataURL(latestQR)}"/>`)
})

app.listen(process.env.PORT || 3000)

/* ================= GOOGLE ================= */

let CREDS = null
if (process.env.GOOGLE_CREDS_JSON_BASE64) {
  CREDS = JSON.parse(Buffer.from(
    process.env.GOOGLE_CREDS_JSON_BASE64,
    'base64'
  ))
}

/* ================= STATE ================= */

const pendingConfirm = {}
const pendingManual = {}
const armedUsers = {}
let starting = false

/* ================= HELPERS ================= */

function normalizeMerchant(name='') {
  return name.replace(/[^a-z0-9 ]/gi,'').toUpperCase().trim().slice(0,40)
}

function learnMerchant(m,k){
  const key = normalizeMerchant(m)
  merchantMemory[key]=merchantMemory[key]||{}
  merchantMemory[key].kategori=k
  saveMemory()
}

function recallMerchantCategory(m){
  return merchantMemory[normalizeMerchant(m)]?.kategori
}

function rememberTotal(m,t){
  const key=normalizeMerchant(m)
  merchantMemory[key]=merchantMemory[key]||{}
  merchantMemory[key].lastTotals =
    (merchantMemory[key].lastTotals||[]).slice(-4).concat(t)
  saveMemory()
}

/* ================= OCR HELPERS ================= */

function normalizeTime(t=''){
  const m=t.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/)
  return m?`${m[1].padStart(2,'0')}:${m[2]}`:null
}

function normalizeDate(d=''){
  const m = d.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
  if(!m) return null
  const dd=m[1].padStart(2,'0')
  const mm=m[2].padStart(2,'0')
  let yy=m[3]
  if(yy.length===2) yy='20'+yy
  return `${dd}/${mm}/${yy}`
}

function extractTime(text=''){
  const m=text.match(/\b([01]?\d|2[0-3])[:.][0-5]\d\b/)
  return m?normalizeTime(m[0]):null
}

function extractDate(text=''){
  const m=text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/)
  return m?normalizeDate(m[0]):null
}

function extractMerchant(text=''){
  return text.split('\n').find(Boolean)?.slice(0,40)||'Struk'
}

function detectPayment(text=''){
  if(/qris/i.test(text)) return 'QRIS'
  if(/cash|tunai/i.test(text)) return 'Cash'
  if(/debit|kredit/i.test(text)) return 'Card'
  return 'Unknown'
}

function detectCategory(text=''){
  if(/alfamart|indomaret/i.test(text)) return 'Belanja'
  if(/resto|kopi|warung/i.test(text)) return 'Makan & Minum'
  if(/grab|gojek/i.test(text)) return 'Transport'
  return 'Lainnya'
}

function extractBestTotal(words=[]){
  let best=null
  for(const w of words){
    if(!/\d{3,}/.test(w.text)) continue
    const v=Number(w.text.replace(/\D/g,''))
    if(!v) continue
    if(!best||w.confidence>best.conf)
      best={value:v,conf:w.confidence}
  }
  return best
}

/* ================= IMAGE ================= */

async function preprocessImage(fp){
  return sharp(fp).rotate().greyscale().normalize().sharpen().toBuffer()
}

/* ================= PREVIEW ================= */

function formatPreview(d){
return `
🧾 *AI EXPENSE ANALYSIS*
🏪 ${d.MERCHANT}
📅 ${d.TANGGAL}
⏰ ${d.JAM}
💰 Rp ${d.TOTAL.toLocaleString('id-ID')}
📦 ${d.KATEGORI}
💳 ${d.METODE}
🔍 Conf ${d.OCR_CONF}

Balas:
Y / N
edit nominal …
edit merchant …
edit kategori …
edit metode …
edit jam …
edit tanggal …
`
}

/* ================= SHEET ================= */

async function saveToSheet(data){
 if(!CREDS) return
 const doc=new GoogleSpreadsheet(SHEET_ID)
 await doc.useServiceAccountAuth(CREDS)
 await doc.loadInfo()
 await doc.sheetsByIndex[0].addRow(data)
}

/* ================= BOT ================= */

async function startBot(){
if(starting) return
starting=true

const {state,saveCreds}=await useMultiFileAuthState(AUTH_DIR)
const {version}=await fetchLatestBaileysVersion()

const sock=makeWASocket({
 version,
 auth:state,
 logger:Pino({level:'silent'}),
 browser:['AIExpense','Chrome','121']
})

sock.ev.on('creds.update',saveCreds)

sock.ev.on('connection.update',({connection,qr})=>{
 if(qr) latestQR=qr
 if(connection==='close'){
  starting=false
  setTimeout(startBot,5000)
 }
})

sock.ev.on('messages.upsert', async ({messages})=>{
const msg=messages[0]
if(!msg?.message||msg.key.fromMe) return

const from=msg.key.remoteJid
const text=
 msg.message.conversation ||
 msg.message.extendedTextMessage?.text ||
 msg.message.imageMessage?.caption || ''

/* ARM */
if(/^pingpong$/i.test(text)){
 armedUsers[from]=true
 return sock.sendMessage(from,{text:'📥 Kirim struk atau ketik manual'})
}

/* ===== MANUAL MODE ===== */

if(pendingManual[from]){
 const lines=text.split('\n')
 const d={
  MERCHANT:'Manual',
  TOTAL:0,
  TANGGAL:new Date().toLocaleDateString('id-ID'),
  JAM:new Date().toLocaleTimeString('id-ID'),
  KATEGORI:'Manual',
  METODE:'Manual',
  OCR_CONF:0
 }

 for(const l of lines){
  if(/total/i.test(l)) d.TOTAL=Number(l.replace(/\D/g,''))
  if(/merchant/i.test(l)) d.MERCHANT=l.split(' ').slice(1).join(' ')
  if(/kategori/i.test(l)) d.KATEGORI=l.split(' ').slice(1).join(' ')
  if(/metode/i.test(l)) d.METODE=l.split(' ').slice(1).join(' ')
  if(/jam/i.test(l)){
    const t=normalizeTime(l.split(' ').pop())
    if(t) d.JAM=t
  }
  if(/tanggal/i.test(l)){
    const dt=normalizeDate(l)
    if(dt) d.TANGGAL=dt
  }
 }

 if(!d.TOTAL)
  return sock.sendMessage(from,{text:'❌ Total belum ada'})

 pendingConfirm[from]=d
 delete pendingManual[from]
 return sock.sendMessage(from,{text:formatPreview(d)})
}

/* ===== CONFIRM ===== */

if(pendingConfirm[from]){
 const d=pendingConfirm[from]

 if(/^y$/i.test(text)){
  learnMerchant(d.MERCHANT,d.KATEGORI)
  rememberTotal(d.MERCHANT,d.TOTAL)
  await saveToSheet(d)
  delete pendingConfirm[from]
  return sock.sendMessage(from,{text:'✅ Disimpan'})
 }

 if(/^n$/i.test(text)){
  delete pendingConfirm[from]
  return sock.sendMessage(from,{text:'❌ Batal'})
 }

 if(/nominal/i.test(text))
  d.TOTAL=Number(text.replace(/\D/g,''))

 if(/merchant/i.test(text))
  d.MERCHANT=text.split(' ').slice(1).join(' ')

 if(/kategori/i.test(text))
  d.KATEGORI=text.split(' ').slice(1).join(' ')

 if(/metode/i.test(text))
  d.METODE=text.split(' ').slice(1).join(' ')

 if(/jam/i.test(text)){
  const t=normalizeTime(text.split(' ').pop())
  if(t) d.JAM=t
 }

 if(/tanggal/i.test(text)){
  const dt=normalizeDate(text)
  if(dt) d.TANGGAL=dt
 }

 return sock.sendMessage(from,{text:formatPreview(d)})
}

/* ===== OCR ===== */

if(!msg.message.imageMessage||!armedUsers[from]) return

try{

 const buf=await downloadMediaMessage(msg,'buffer')
 const file=path.join(IMAGE_DIR,Date.now()+'.jpg')
 fs.writeFileSync(file,buf)

 const processed=await preprocessImage(file)
 const {data}=await Tesseract.recognize(processed,'eng+ind')

 if(data.confidence < 55){
   pendingManual[from]=true
   armedUsers[from]=false
   return sock.sendMessage(from,{text:
`❌ OCR gagal

Input manual:
total 15000
merchant Indomaret
kategori Belanja
metode QRIS
tanggal 17/02/2026
jam 14:22`
})
 }

 const best=extractBestTotal(data.words)
 if(!best) throw new Error()

 const d={
  MERCHANT:extractMerchant(data.text),
  TOTAL:best.value,
  TANGGAL:extractDate(data.text)||new Date().toLocaleDateString('id-ID'),
  JAM:extractTime(data.text)||new Date().toLocaleTimeString('id-ID'),
  KATEGORI:recallMerchantCategory(extractMerchant(data.text)) || detectCategory(data.text),
  METODE:detectPayment(data.text),
  OCR_CONF:Math.round(data.confidence)
 }

 pendingConfirm[from]=d
 armedUsers[from]=false

 return sock.sendMessage(from,{text:formatPreview(d)})

}catch{
 pendingManual[from]=true
 armedUsers[from]=false
 return sock.sendMessage(from,{text:
`❌ OCR gagal

Input manual:
total
merchant
kategori
metode
tanggal
jam`
})
}

})

}

startBot()
