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
  DisconnectReason,
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
const armedUsers = {}
let starting = false

/* ================= AI HELPERS ================= */

function hashReceipt(text) {
  return crypto.createHash('md5')
    .update(text.replace(/\s+/g,''))
    .digest('hex')
}

function normalizeMerchant(name='') {
  return name
    .replace(/[^a-z0-9 ]/gi,'')
    .toUpperCase()
    .trim()
    .slice(0,40)
}

function learnMerchant(merchant, kategori) {
  const key = normalizeMerchant(merchant)
  merchantMemory[key] = merchantMemory[key] || {}
  merchantMemory[key].kategori = kategori
  saveMemory()
}

function recallMerchantCategory(merchant) {
  const key = normalizeMerchant(merchant)
  return merchantMemory[key]?.kategori
}

function anomalyCheck(merchant, total) {
  const key = normalizeMerchant(merchant)
  const hist = merchantMemory[key]?.lastTotals || []
  if (!hist.length) return false
  const avg = hist.reduce((a,b)=>a+b,0)/hist.length
  return total > avg * 3
}

function rememberTotal(merchant, total) {
  const key = normalizeMerchant(merchant)
  merchantMemory[key] = merchantMemory[key] || {}
  merchantMemory[key].lastTotals = merchantMemory[key].lastTotals || []
  merchantMemory[key].lastTotals.push(total)
  merchantMemory[key].lastTotals =
    merchantMemory[key].lastTotals.slice(-5)
  saveMemory()
}

/* ================= OCR ================= */

function normalizeTime(t='') {
  const m = t.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/)
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : null
}

function extractTime(text='') {
  const m = text.match(/\b([01]?\d|2[0-3])[:.][0-5]\d\b/)
  return m ? normalizeTime(m[0]) : null
}

function extractDate(text='') {
  return text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/)?.[0]
}

function extractMerchant(text='') {
  return text.split('\n').find(Boolean)?.slice(0,40) || 'Struk'
}

function detectPayment(text='') {
  const t = text.toLowerCase()
  if (/qris/.test(t)) return 'QRIS'
  if (/cash|tunai/.test(t)) return 'Cash'
  if (/debit|kredit/.test(t)) return 'Card'
  return 'Unknown'
}

function detectCategory(text='') {
  const t = text.toLowerCase()
  if (/alfamart|indomaret/.test(t)) return 'Belanja'
  if (/resto|kopi|warung/.test(t)) return 'Makan & Minum'
  if (/grab|gojek/.test(t)) return 'Transport'
  return 'Lainnya'
}

function extractBestTotal(words=[]) {
  let best=null
  for (const w of words) {
    if (!/\d{3,}/.test(w.text)) continue
    const v = Number(w.text.replace(/\D/g,''))
    if (!v) continue
    if (!best || w.confidence > best.conf)
      best = { value:v, conf:w.confidence }
  }
  return best
}

/* ================= IMAGE PREPROCESS ================= */

async function preprocessImage(fp) {
  return sharp(fp)
    .rotate()
    .greyscale()
    .normalize()
    .sharpen()
    .toBuffer()
}

/* ================= PREVIEW ================= */

function formatPreview(d) {
return `
🧾 *AI EXPENSE ANALYSIS*
🏪 ${d.MERCHANT}
📅 ${d.TANGGAL}
⏰ ${d.JAM}
💰 Rp ${d.TOTAL.toLocaleString('id-ID')}
📦 ${d.KATEGORI}
💳 ${d.METODE}
🔍 Conf ${d.OCR_CONF}

Balas Y / N
edit nominal …
edit merchant …
edit kategori …
edit jam …
`
}

/* ================= SHEET ================= */

async function saveToSheet(data) {
  if (!CREDS) return
  const doc = new GoogleSpreadsheet(SHEET_ID)
  await doc.useServiceAccountAuth(CREDS)
  await doc.loadInfo()
  await doc.sheetsByIndex[0].addRow(data)
}

/* ================= BOT ================= */

async function startBot() {
if (starting) return
starting = true

const { state, saveCreds } =
  await useMultiFileAuthState(AUTH_DIR)

const { version } =
  await fetchLatestBaileysVersion()

const sock = makeWASocket({
  version,
  auth: state,
  logger: Pino({ level:'silent' }),
  browser:['AIExpense','Chrome','121']
})

sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', ({connection,qr})=>{
  if(qr) latestQR=qr
  if(connection==='close'){
    starting=false
    setTimeout(startBot,5000)
  }
})

sock.ev.on('messages.upsert', async ({messages})=>{
const msg = messages[0]
if (!msg?.message || msg.key.fromMe) return

const from = msg.key.remoteJid
const text =
 msg.message.conversation ||
 msg.message.extendedTextMessage?.text ||
 msg.message.imageMessage?.caption || ''

/* ARM */
if (/^pingpong$/i.test(text)) {
 armedUsers[from]=true
 return sock.sendMessage(from,{text:'📥 Kirim struk'})
}

/* CONFIRM */
if (pendingConfirm[from]) {
 const d = pendingConfirm[from]

 if (/^y$/i.test(text)) {
   learnMerchant(d.MERCHANT, d.KATEGORI)
   rememberTotal(d.MERCHANT, d.TOTAL)
   await saveToSheet(d)
   delete pendingConfirm[from]
   return sock.sendMessage(from,{text:'✅ Disimpan'})
 }

 if (/^n$/i.test(text)) {
   delete pendingConfirm[from]
   return sock.sendMessage(from,{text:'❌ Batal'})
 }

 if (/nominal/i.test(text))
   d.TOTAL = Number(text.replace(/\D/g,''))

 if (/kategori/i.test(text)) {
   d.KATEGORI = text.split(' ').slice(1).join(' ')
   learnMerchant(d.MERCHANT, d.KATEGORI)
 }

 if (/jam/i.test(text)) {
   const t = normalizeTime(text.split(' ').pop())
   if (t) d.JAM = t
 }

 return sock.sendMessage(from,{text:formatPreview(d)})
}

/* OCR */
if (!msg.message.imageMessage || !armedUsers[from]) return

try {

 const buf = await downloadMediaMessage(msg,'buffer')
 const file = path.join(IMAGE_DIR, Date.now()+'.jpg')
 fs.writeFileSync(file, buf)

 const processed = await preprocessImage(file)
 const { data } =
   await Tesseract.recognize(processed,'eng+ind')

 const hash = hashReceipt(data.text)
 if (receiptHashes.has(hash)) {
   armedUsers[from]=false
   return sock.sendMessage(from,{text:'⚠️ Struk duplikat'})
 }
 receiptHashes.add(hash)

 const best = extractBestTotal(data.words)
 if (!best) throw new Error()

 const merchant = extractMerchant(data.text)
 const learnedCat = recallMerchantCategory(merchant)

 const d = {
   MERCHANT: merchant,
   TOTAL: best.value,
   TANGGAL: extractDate(data.text)
            || new Date().toLocaleDateString('id-ID'),
   JAM: extractTime(data.text)
        || new Date().toLocaleTimeString('id-ID'),
   KATEGORI: learnedCat || detectCategory(data.text),
   METODE: detectPayment(data.text),
   OCR_CONF: Math.round(data.confidence)
 }

 if (anomalyCheck(d.MERCHANT, d.TOTAL)) {
   await sock.sendMessage(from,{
     text:'⚠️ Nominal tidak biasa untuk merchant ini'
   })
 }

 pendingConfirm[from]=d
 armedUsers[from]=false

 return sock.sendMessage(from,{
   text: formatPreview(d)
 })

} catch {
 armedUsers[from]=false
 return sock.sendMessage(from,{text:'❌ OCR gagal'})
}

})

}

startBot()
