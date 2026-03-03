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
/* ================= CONFIG ================= */
const BASE_DIR = path.join('/app/data')

const AUTH_DIR = path.join(BASE_DIR, 'auth')
const IMAGE_DIR = path.join(BASE_DIR, 'images')
const MEMORY_FILE = path.join(BASE_DIR, 'merchant_memory.json')
const SHEET_ID = '1qjSndza2fwNhkQ6WzY9DGhunTHV7cllbs75dnG5I6r4'

if (!fs.existsSync(BASE_DIR)) {
  fs.mkdirSync(BASE_DIR)
}

for (const d of [AUTH_DIR, IMAGE_DIR]) {
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true })
  }
}

/* ================= MEMORY ================= */

let merchantMemory = {}
if (fs.existsSync(MEMORY_FILE)) {
  try{
    merchantMemory = JSON.parse(fs.readFileSync(MEMORY_FILE))
  }catch{
    merchantMemory = {}
  }
}


function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(merchantMemory, null, 2))
}

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

if (
  process.env.GOOGLE_CREDS_JSON_BASE64 &&
  process.env.GOOGLE_CREDS_JSON_BASE64.trim() !== ''
) {
  try {
    CREDS = JSON.parse(
      Buffer.from(
        process.env.GOOGLE_CREDS_JSON_BASE64,
        'base64'
      ).toString()
    )
    console.log('✅ Google creds loaded')
  } catch (err) {
    console.error('❌ Invalid GOOGLE_CREDS_JSON_BASE64')
    CREDS = null
  }
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

function extractMerchant(text=''){
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  for(const l of lines){

    // Skip header umum
    if(/struk|pembayaran|invoice|receipt/i.test(l))
      continue

    // Skip baris dominan angka
    const letters = (l.match(/[A-Za-z]/g) || []).length
    const numbers = (l.match(/\d/g) || []).length
    if(numbers > letters)
      continue

    // Skip terlalu pendek
    if(l.length < 3)
      continue

    // Prioritaskan yang banyak huruf kapital
    const uppercaseCount = (l.match(/[A-Z]/g) || []).length
    if(uppercaseCount >= 3){
      return l.slice(0,40)
    }
  }

  // fallback kalau semua gagal
  return lines[0]?.slice(0,40) || 'Struk'
}

function detectPayment(text=''){
  if(/qris/i.test(text)) return 'QRIS'
  if(/cash|tunai/i.test(text)) return 'Cash'
  if(/debit|kredit/i.test(text)) return 'Card'
  return 'Unknown'
}

function detectCategory(text=''){
  text=text.toLowerCase()

  if(/spbu|pertamina|shell/i.test(text))
    return 'Transport'

  if(/alfamart|indomaret/i.test(text))
    return 'Belanja'

  if(/grab|gojek/i.test(text))
    return 'Transport'

  if(/resto|kopi|warung|cafe|coffee/i.test(text))
    return 'Makan & Minum'

  if(/apotek|kimia farma/i.test(text))
    return 'Kesehatan'

  if(/tokopedia|shopee|lazada/i.test(text))
    return 'Online Shopping'

  if(/pln|listrik|pdam/i.test(text))
    return 'Tagihan'

  return 'Lainnya'
}

function extractSmartTotal(text='', words=[]){

  const lines = text.split('\n')

  // 1️⃣ Prioritas keyword TOTAL
  const priorityKeywords = [
    /grand total/i,
    /total bayar/i,
    /^total/i,
    /jumlah/i
  ]

  for(const line of lines){
    for(const k of priorityKeywords){
      if(k.test(line)){
        const nums = line.match(/\d[\d.,]+/g)
        if(nums){
          const clean = nums.map(n =>
            Number(n.replace(/[^\d]/g,''))
          ).filter(Boolean)

          if(clean.length){
            return {
              value: Math.max(...clean),
              conf: 999
            }
          }
        }
      }
    }
  }

  // 2️⃣ Hindari tunai/kembali
  const blacklist = /tunai|cash|kembali|change/i

  let best=null
  for(const w of words){
    if(!/\d{3,}/.test(w.text)) continue
    if(blacklist.test(w.line?.text || '')) continue

    const v=Number(w.text.replace(/\D/g,''))
    if(!v) continue

    if(!best || w.confidence > best.conf)
      best={value:v,conf:w.confidence}
  }

  return best
}

async function preprocessImage(fp){
  return sharp(fp).rotate().greyscale().normalize().sharpen().toBuffer()
}

/* ================= PREVIEW ================= */

function formatPreview(d){
return `
🧾 * FINANCE ANALYSIS*
📌 Type: ${d.TYPE || 'Expense'}
🏪 ${d.MERCHANT}
📅 ${d.TANGGAL}
⏰ ${d.JAM}
💰 Rp ${(d.TOTAL || 0).toLocaleString('id-ID')}
📦 ${d.KATEGORI}
💳 ${d.METODE}
🏦 Dari: ${d.AKUN_ASAL || '-'}
🏦 Ke: ${d.AKUN_TUJUAN || '-'}
🔍 Conf ${d.OCR_CONF}

Balas:
Y / N
edit nominal …
edit merchant …
edit kategori …
edit metode …
edit asal …
edit tujuan …
edit jam …
edit tanggal …
edit type Income / Expense / Transfer
`
}

/* ================= SHEET ================= */

async function saveToSheet(d){
 if(!CREDS) return

 const doc = new GoogleSpreadsheet(SHEET_ID)
 await doc.useServiceAccountAuth(CREDS)
 await doc.loadInfo()

 const sheet = doc.sheetsByIndex[0]

 const id = crypto.randomUUID()

 await sheet.addRow({
  ID: id,
  TYPE: d.TYPE,
  MERCHANT: d.MERCHANT,
  TANGGAL: d.TANGGAL,
  JAM: d.JAM,
  TOTAL: d.TOTAL,
  KATEGORI: d.KATEGORI,
  METODE: d.METODE,
  AKUN_ASAL: d.AKUN_ASAL,
  AKUN_TUJUAN: d.AKUN_TUJUAN
 })
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

/* ===== ARM ===== */
if(/^pingpong$/i.test(text)){
 armedUsers[from]=true
 return sock.sendMessage(from,{text:'📥 Kirim struk atau ketik manual'})
}

// ===== GUARD =====
if(pendingConfirm[from] && /^manual$/i.test(text)){
  return sock.sendMessage(from,{text:'❗ Selesaikan konfirmasi dulu (Y / N)'})
}

/* ===== MANUAL TRIGGER (WAJIB SUDAH PINGPONG) ===== */
if(/^manual$/i.test(text) && armedUsers[from]){
 pendingManual[from]=true
 armedUsers[from]=false
 return sock.sendMessage(from,{text:
`✍️ Input manual:

type expense/income/transfer
total
merchant
kategori
metode
asal
tujuan
tanggal
jam`
})
}

//* ===== MANUAL MODE ===== */
if(pendingManual[from]){

  if(!text.trim()) return   // 🔥 Tambahkan ini

  const lines = text.split('\n')
 const d={
  TYPE:'Expense',
  MERCHANT:'Manual',
  TOTAL:0,
  AKUN_ASAL:'',
  AKUN_TUJUAN:'',
  TANGGAL:new Date().toLocaleDateString('id-ID'),
  JAM:new Date().toLocaleTimeString('id-ID'),
  KATEGORI:'Manual',
  METODE:'Manual',
  OCR_CONF:0
}

for(const l of lines){

  // ===== TYPE =====
  // ===== TYPE =====
if(/type/i.test(l)){
  if(/income/i.test(l)){
    d.TYPE='Income'
  } 
  else if(/transfer/i.test(l)){
    d.TYPE='Transfer'
  } 
  else{
    d.TYPE='Expense'
  }
}

  // ===== TOTAL =====
  if(/total/i.test(l))
    d.TOTAL=Number(l.replace(/\D/g,''))

  // ===== MERCHANT =====
  if(/merchant/i.test(l))
    d.MERCHANT=l.split(' ').slice(1).join(' ')

  // ===== KATEGORI =====
  if(/kategori/i.test(l))
    d.KATEGORI=l.split(' ').slice(1).join(' ')

  // ===== METODE =====
  if(/metode/i.test(l))
    d.METODE=l.split(' ').slice(1).join(' ')

  // ===== AKUN ASAL =====
  if(/asal/i.test(l))
    d.AKUN_ASAL=l.split(' ').slice(1).join(' ')

  // ===== AKUN TUJUAN =====
  if(/tujuan/i.test(l))
    d.AKUN_TUJUAN=l.split(' ').slice(1).join(' ')

  // ===== JAM =====
  if(/jam/i.test(l)){
    const t=normalizeTime(l.split(' ').pop())
    if(t) d.JAM=t
  }

  // ===== TANGGAL =====
  if(/tanggal/i.test(l)){
    const dt=normalizeDate(l)
    if(dt) d.TANGGAL=dt
  }
}

// ================================
// 🔥 AUTO ACCOUNT LOGIC
// ================================

if(d.TYPE === 'Income'){
  d.AKUN_ASAL = ''
}

if(d.TYPE === 'Transfer'){
  if(!d.AKUN_ASAL || !d.AKUN_TUJUAN){
    return sock.sendMessage(from,{text:'❌ Transfer harus isi asal dan tujuan'})
  }
}

// ================================

if(!d.TOTAL)
  return sock.sendMessage(from,{text:'❌ Total belum ada'})

pendingConfirm[from]=d
delete pendingManual[from]
return sock.sendMessage(from,{text:formatPreview(d)})

}   // ← TAMBAHKAN INI (menutup manual mode)

/* ===== CONFIRM ===== */
if(pendingConfirm[from]){

 const d = pendingConfirm[from]

 if(/^y$/i.test(text)){

   if(d.TOTAL <= 0){
     return sock.sendMessage(from,{text:'❌ Nominal tidak valid'})
   }

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

 if(/^edit type/i.test(text)){
   if(/income/i.test(text)) d.TYPE='Income'
   else if(/transfer/i.test(text)) d.TYPE='Transfer'
   else d.TYPE='Expense'
 }

if(/^edit nominal/i.test(text)){
  const v = Number(text.replace(/\D/g,''))
  if(v > 0) d.TOTAL = v
}

if(/^edit merchant/i.test(text))
  d.MERCHANT = text.split(' ').slice(2).join(' ')

if(/^edit kategori/i.test(text))
  d.KATEGORI = text.split(' ').slice(2).join(' ')

if(/^edit metode/i.test(text))
  d.METODE = text.split(' ').slice(2).join(' ')
if(/^edit asal/i.test(text))
  d.AKUN_ASAL = text.split(' ').slice(2).join(' ')

if(/^edit tujuan/i.test(text))
  d.AKUN_TUJUAN = text.split(' ').slice(2).join(' ')

if(/^edit jam/i.test(text)){
  const t = normalizeTime(text.split(' ').pop())
  if(t) d.JAM = t
}

if(/^edit tanggal/i.test(text)){
  const dt = normalizeDate(text)
  if(dt) d.TANGGAL = dt
}

 // 🔥 AUTO ACCOUNT LOGIC HARUS DI SINI
 // 🔥 AUTO ACCOUNT LOGIC
if(d.TYPE === 'Income'){
  d.AKUN_ASAL = ''
}

if(d.TYPE === 'Transfer'){
  if(!d.AKUN_ASAL || !d.AKUN_TUJUAN){
    return sock.sendMessage(from,{text:'❌ Transfer harus isi asal dan tujuan'})
  }
}
 return sock.sendMessage(from,{text:formatPreview(d)})
}

/* ===== OCR ===== */
if(!msg.message.imageMessage||!armedUsers[from]) return

try{
 const buf = await downloadMediaMessage(
  msg,
  'buffer',
  {},
  { logger: Pino({ level: 'silent' }) }
)
 const file=path.join(IMAGE_DIR,Date.now()+'.jpg')
 fs.writeFileSync(file,buf)

 const processed=await preprocessImage(file)
 const {data}=await Tesseract.recognize(processed,'eng+ind')

const best = extractSmartTotal(data.text, data.words)

if(!best){
  await sock.sendMessage(from,{
    text:'❌ Tidak bisa menemukan TOTAL di struk.\nKetik manual 50000 atau kirim ulang foto yang lebih jelas.'
  })
  return
}

const merchant = extractMerchant(data.text)

const d = {
  TYPE:'Expense',
  MERCHANT: merchant,
  TOTAL: best.value,
  AKUN_ASAL:'',
  AKUN_TUJUAN:'',
  TANGGAL:new Date().toLocaleDateString('id-ID'),
  JAM:new Date().toLocaleTimeString('id-ID'),
  KATEGORI: recallMerchantCategory(merchant) || detectCategory(data.text),
  METODE: detectPayment(data.text),
  OCR_CONF: Math.round(data.confidence)
}

 pendingConfirm[from]=d
 armedUsers[from]=false
 return sock.sendMessage(from,{text:formatPreview(d)})

}catch{
 pendingManual[from]=true
 armedUsers[from]=false
 return sock.sendMessage(from,{text:'❌ OCR gagal, ketik manual'})
}

})

}

startBot()