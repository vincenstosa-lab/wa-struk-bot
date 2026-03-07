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

let pendingConfirm = {}
let armedUsers = {}
let pendingManual = {}
let lastSaved = {}

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

app.get('/qr', async (req, res) => {
  if (!latestQR) {
    return res.send(`
      <h2>Menunggu QR...</h2>
      <script>
        setTimeout(() => location.reload(), 2000)
      </script>
    `)
  }

  const qrImage = await QRCode.toDataURL(latestQR)

  res.send(`
    <h2>Scan QR WhatsApp</h2>
    <img src="${qrImage}" />
    <p>QR akan auto refresh jika expired</p>
    <script>
      setTimeout(() => location.reload(), 15000)
    </script>
  `)
})

const PORT = process.env.PORT || 3000

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`)
})

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

const ACCOUNT_KEYWORDS = {
  bca: 'BCA',
  mandiri: 'Mandiri',
  bri: 'BRI',
  bni: 'BNI',
  gopay: 'GoPay',
  ovo: 'OVO',
  dana: 'DANA',
  shopeepay: 'ShopeePay',
  linkaja: 'LinkAja',
  cash: 'Cash',
  tunai: 'Cash'
}

const RECURRING_KEYWORDS = [
'netflix',
'spotify',
'indihome',
'pln',
'pdam',
'wifi',
'internet',
'icloud',
'google storage',
'youtube premium'
]

function detectPayment(text=''){
  if(/qris/i.test(text)) return 'QRIS'
  if(/cash|tunai/i.test(text)) return 'Cash'
  if(/debit|kredit/i.test(text)) return 'Card'
  return 'Unknown'
}

function detectAccount(text=''){
  text = text.toLowerCase()

  for(const key in ACCOUNT_KEYWORDS){
    if(text.includes(key)){
      return ACCOUNT_KEYWORDS[key]
    }
  }

  return ''
}

function parseNaturalInput(text=''){

text = text.toLowerCase()

// ===== SPLIT DETECTION =====
let split = 1
const splitMatch = text.match(/\/\s*(\d+)/)

if(splitMatch){
  split = Number(splitMatch[1])
  text = text.replace(splitMatch[0],'')
}

// ===== DETECT NOMINAL =====
const amountMatch =
  text.match(/(\d+(?:[.,]\d+)?)(?:\s?(k|rb|jt))/) ||
  text.match(/\b\d{4,}\b/)
let total = 0

if(amountMatch){

let num = parseFloat(amountMatch[1].replace(',', '.'))
const unit = amountMatch[2] || ''

 if(unit === 'k' || unit === 'rb')
  num *= 1000

 if(unit === 'jt')
  num *= 1000000

 total = Math.round(num)

}

// ===== APPLY SPLIT =====
if(split > 1){
  total = Math.round(total / split)
}

// ===== TYPE DETECTION =====
let type = 'Expense'

if(/gaji|salary|income|masuk|refund/i.test(text))
  type = 'Income'

if(/transfer/i.test(text))
  type = 'Transfer'

// ===== MERCHANT =====
let merchant = text
  .replace(amountMatch?.[0] || '', '')
  .replace(/\b(gaji|salary|income|masuk|refund|transfer)\b/gi,'')
  .replace(/\b(cash|qris|debit|kredit|gopay|ovo|dana|bca|bri|bni|mandiri|shopeepay)\b/gi,'')
  .trim()

if(!merchant)
  merchant = 'Manual'

return {
 total,
 merchant,
 type,
 split
}

}

 
function getDateTime() {
  const now = new Date()

  const date = now.toLocaleDateString('id-ID', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })

  const time = now.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit'
  })

  return { date, time }
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

function detectRecurring(text=''){

text = text.toLowerCase()

for(const r of RECURRING_KEYWORDS){
  if(text.includes(r)){
    return true
  }
}

return false

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

if(v > 100000000) continue

if(!v) continue

    if(!best || w.confidence > best.conf)
      best={value:v,conf:w.confidence}
  }

  return best
}

async function preprocessImage(fp){
  return sharp(fp)
    .rotate()
    .resize(1200) // mengecilkan gambar supaya OCR cepat
    .greyscale()
    .normalize()
    .sharpen()
    .toBuffer()
}

/* ================= PREVIEW ================= */

function formatPreview(d){
return `
🧾 *FINANCE ANALYSIS*
📌 Type: ${d.TYPE || 'Expense'}
🏪 ${d.MERCHANT}
📅 ${d.TANGGAL}
⏰ ${d.JAM}
💰 Rp ${(d.TOTAL || 0).toLocaleString('id-ID')}
📦 ${d.KATEGORI}
💳 ${d.METODE}
📝 ${d.KETERANGAN || '-'}
🏦 Dari: ${d.AKUN_ASAL || '-'}
🏦 Ke: ${d.AKUN_TUJUAN || '-'}
🔍 Conf ${d.OCR_CONF}

Balas:
Y / N
edit type Income / Expense / Transfer
edit nominal …
edit merchant …
edit kategori …
edit metode …
edit keterangan
edit asal …
edit tujuan …
edit jam …
edit tanggal …
`
}

/* ================= SHEET ================= */

async function saveToSheet(d, user){

 if(!CREDS){
   console.log("❌ CREDS NOT FOUND")
   return
 }

 console.log("Saving to sheet...")

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
  KETERANGAN: d.KETERANGAN,
  AKUN_ASAL: d.AKUN_ASAL,
  AKUN_TUJUAN: d.AKUN_TUJUAN
 })

 // 🔥 simpan id transaksi terakhir
 lastSaved[user] = id

 console.log("Saved:", id)

}


function parseFinanceText(text) {
  const get = (regex) => {
    const m = text.match(regex)
    return m ? m[1].trim() : ''
  }

  return {
    merchant: get(/Merchant\s*(.*)/i),
    kategori: get(/Kategori\s*(.*)/i),
    metode: get(/Metode\s*(.*)/i),
    asal: get(/asal\s*(.*)/i),
    jam: get(/Jam\s*([0-9]{1,2}[.:][0-9]{2})/i),
    keterangan: get(/Keterangan\s*(.*)/i),
    nominal: get(/Rp\s*([\d.]+)/i)
  }
}
/* ================= BOT ================= */
let starting = false
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

sock.ev.on('connection.update',(update)=>{
  const {connection,qr} = update

  console.log('Connection update:', connection || 'no-state')

  if(qr){
    console.log('QR generated')
    latestQR = qr
  }

  if(connection === 'open'){
    console.log('WA CONNECTED')
    latestQR = null
  }

  if(connection === 'close'){
  console.log('WA CLOSED')

  const reason = update?.lastDisconnect?.error?.output?.statusCode
  console.log('Reason:', reason)

  starting = false
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

/* ===== NATURAL INPUT ===== */
/* ===== NATURAL INPUT ===== */
if(armedUsers[from] && text && !msg.message.imageMessage){

 const parsed = parseNaturalInput(text)

 const words = text.split(/\s+/)

let akunAsal=''
let akunTujuan=''

for(const w of words){

 const acc = detectAccount(w)

 if(acc && !akunAsal){
   akunAsal = acc
 }
 else if(acc && !akunTujuan){
   akunTujuan = acc
 }

}


 if(parsed.total){

   const accountDetected = detectAccount(text)

   const d = {
     TYPE: parsed.type,
     MERCHANT: parsed.merchant,
     TOTAL: parsed.total,
    AKUN_ASAL: akunAsal || accountDetected, 
    AKUN_TUJUAN: parsed.akunTujuan || '',
     TANGGAL:new Date().toLocaleDateString('id-ID',{
       day:'2-digit',
       month:'2-digit',
       year:'numeric'
     }),
     JAM:new Date().toLocaleTimeString('id-ID',{
       hour:'2-digit',
       minute:'2-digit'
     }),
     KATEGORI: recallMerchantCategory(parsed.merchant) || detectCategory(text),
     METODE: detectPayment(text),
     KETERANGAN: detectRecurring(text) ? 'Recurring' : '',
     OCR_CONF:100
   }

   pendingConfirm[from]=d
   armedUsers[from]=false

   return sock.sendMessage(from,{text:formatPreview(d)})
 }

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
keterangan
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
  KETERANGAN:'',
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
  // EDIT MERCHANT

 if(/type/i.test(l)){
  if(/income/i.test(l)) d.TYPE='Income'
  else if(/transfer/i.test(l)) d.TYPE='Transfer'
  else d.TYPE='Expense'
 }

 if(/total/i.test(l)){
  const v = Number(l.replace(/\D/g,''))
  if(v) d.TOTAL = v
 }

 if(/merchant/i.test(l)){
  d.MERCHANT = l.replace(/merchant/i,'').trim()
 }

 if(/kategori/i.test(l)){
  d.KATEGORI = l.replace(/kategori/i,'').trim()
 }

 if(/metode/i.test(l)){
  d.METODE = l.replace(/metode/i,'').trim()
 }

 if(/keterangan/i.test(l)){
  d.KETERANGAN = l.replace(/keterangan/i,'').trim()
 }

 if(/asal/i.test(l)){
  d.AKUN_ASAL = l.replace(/asal/i,'').trim()
 }

 if(/tujuan/i.test(l)){
  d.AKUN_TUJUAN = l.replace(/tujuan/i,'').trim()
 }

 if(/jam/i.test(l)){
  const t = normalizeTime(l.split(' ').pop())
  if(t) d.JAM = t
 }

 if(/tanggal/i.test(l)){
  const dt = normalizeDate(l)
  if(dt) d.TANGGAL = dt
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
   await saveToSheet(d, from)
   delete pendingConfirm[from]
   return sock.sendMessage(from,{text:'✅ Disimpan'})
}

 if(/^n$/i.test(text)){
   delete pendingConfirm[from]
   return sock.sendMessage(from,{text:'❌ Batal'})
 }

 if(/^(edit )?type/i.test(text)){
   if(/income/i.test(text)) d.TYPE='Income'
   else if(/transfer/i.test(text)) d.TYPE='Transfer'
   else d.TYPE='Expense'
 }

if(/^(edit )?nominal/i.test(text)){
  const v = Number(text.replace(/\D/g,''))
  if(v > 0) d.TOTAL = v
}

if(/^(edit )?merchant\b/i.test(text)){
  d.MERCHANT = text.replace(/^(edit )?merchant\b/i,'').trim()
  return sock.sendMessage(from,{text:formatPreview(d)})
}

// EDIT KATEGORI
if(/^(edit )?kategori\b/i.test(text)){
  d.KATEGORI = text.replace(/^(edit )?kategori\b/i,'').trim()
  return sock.sendMessage(from,{text:formatPreview(d)})
}

// EDIT METODE
if(/^(edit )?metode\b/i.test(text)){
  d.METODE = text.replace(/^(edit )?metode\b/i,'').trim()
  return sock.sendMessage(from,{text:formatPreview(d)})
}

if(/^(edit )?(ket|keterangan)\b/i.test(text)){
  d.KETERANGAN = text.replace(/^(edit )?(ket|keterangan)\b/i,'').trim()
  return sock.sendMessage(from,{text:formatPreview(d)})
}

// EDIT ASAL
if(/^(edit )?asal\b/i.test(text)){
  d.AKUN_ASAL = text.replace(/^(edit )?asal\b/i,'').trim()
  return sock.sendMessage(from,{text:formatPreview(d)})
}

// EDIT TUJUAN
if(/^(edit )?tujuan\b/i.test(text)){
  d.AKUN_TUJUAN = text.replace(/^(edit )?tujuan\b/i,'').trim()
  return sock.sendMessage(from,{text:formatPreview(d)})
}

if(/^(edit )?jam\b/i.test(text)){
  const t = normalizeTime(text.replace(/^(edit )?jam\b/i,'').trim())
  if(t) d.JAM = t
  return sock.sendMessage(from,{text:formatPreview(d)})

}

if(/^(edit )?tanggal\b/i.test(text)){
  const dt = normalizeDate(text.replace(/^(edit )?tanggal\b/i,'').trim())
  if(dt) d.TANGGAL = dt
  return sock.sendMessage(from,{text:formatPreview(d)})
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

/* ===== UNDO LAST SAVE ===== */
if(/^undo$/i.test(text)){

  const lastId = lastSaved[from]

  if(!lastId){
    return sock.sendMessage(from,{text:'❌ Tidak ada transaksi yang bisa di-undo'})
  }

  const doc = new GoogleSpreadsheet(SHEET_ID)
  await doc.useServiceAccountAuth(CREDS)
  await doc.loadInfo()

  const sheet = doc.sheetsByIndex[0]
  const rows = await sheet.getRows()

  const row = rows.find(r => r.ID === lastId)

  if(!row){
    return sock.sendMessage(from,{text:'❌ Data tidak ditemukan'})
  }

  await row.delete()

  delete lastSaved[from]

  return sock.sendMessage(from,{text:'↩️ Transaksi terakhir dibatalkan'})
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
const accountDetected = detectAccount(data.text)

const d = {
  TYPE:'Expense',
  MERCHANT: merchant,
  TOTAL: best.value,
  AKUN_ASAL: accountDetected,
  AKUN_TUJUAN:'',
  TANGGAL:new Date().toLocaleDateString('id-ID'),
  JAM:new Date().toLocaleTimeString('id-ID'),
  KATEGORI: recallMerchantCategory(merchant) || detectCategory(data.text),
  METODE: detectPayment(data.text),
  KETERANGAN: detectRecurring(data.text) ? 'Recurring' : '', 
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