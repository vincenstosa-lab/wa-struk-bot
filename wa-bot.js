/* ================= SAFE GUARD ================= */
process.on('uncaughtException', err => console.error('❌ Uncaught:', err))
process.on('unhandledRejection', err => console.error('❌ Rejection:', err))

/* ================= IMPORT ================= */
const express = require('express')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} = require('@whiskeysockets/baileys')

const qrcode = require('qrcode-terminal')
const Pino = require('pino')
const fs = require('fs')
const path = require('path')
const Tesseract = require('tesseract.js')
const { GoogleSpreadsheet } = require('google-spreadsheet')

/* ================= HTTP SERVER (KOYEB) ================= */
const app = express()
app.get('/', (_, res) => res.send('✅ WA Struk Bot running'))
app.get('/health', (_, res) => res.json({ ok:true, uptime:process.uptime() }))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('🌐 HTTP server on', PORT))

/* ================= CONFIG ================= */
const SHEET_ID = '1qjSndza2fwNhkQ6WzY9DGhunTHV7cllbs75dnG5I6r4'
const CREDS = process.env.GOOGLE_CREDS_JSON
  ? JSON.parse(process.env.GOOGLE_CREDS_JSON)
  : null

const IMAGE_DIR = './images'
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR)

/* ================= STATE ================= */
const pendingConfirm = {}

/* ================= DATE MAP ================= */
const MONTHS = {
  januari:0,februari:1,maret:2,april:3,mei:4,juni:5,
  juli:6,agustus:7,september:8,oktober:9,november:10,desember:11
}

/* ================= HELPERS ================= */
// 💰 TOTAL
function extractTotalFinal(text='') {
  const nums = text.match(/\d{1,3}([.,]\d{3})+/g)
  return nums ? Math.max(...nums.map(n=>parseInt(n.replace(/[.,]/g,'')))) : null
}

// 📅 DATE
function extractDateTime(text='') {
  text=text.toLowerCase()
  const p=/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/
  const m=text.match(p)
  if(!m) return new Date()
  return new Date(m[3].length===2?'20'+m[3]:m[3],m[2]-1,m[1])
}

// 🏪 MERCHANT
function extractMerchantOCR(text='') {
  return text.split('\n')
    .map(l=>l.trim())
    .filter(l=>l.length>5 && !/\d/.test(l))[0] || 'Merchant'
}

// 📂 KATEGORI
function detectCategory(t='') {
  t=t.toLowerCase()
  if(/makan|kopi|cafe|resto/.test(t)) return 'Konsumsi'
  if(/alfamart|indomaret/.test(t)) return 'Belanja'
  if(/grab|gojek/.test(t)) return 'Transport'
  return 'Lainnya'
}

// 💾 SHEET
async function saveToSheet(d){
  if(!CREDS) return
  const doc=new GoogleSpreadsheet(SHEET_ID)
  await doc.useServiceAccountAuth(CREDS)
  await doc.loadInfo()
  await doc.sheetsByIndex[0].addRow(d)
}

// 📊 SUMMARY
async function getMonthlyRows(month=null){
  if(!CREDS) return []
  const doc=new GoogleSpreadsheet(SHEET_ID)
  await doc.useServiceAccountAuth(CREDS)
  await doc.loadInfo()
  const rows=await doc.sheetsByIndex[0].getRows()
  const now=new Date()
  return rows.filter(r=>{
    const d=new Date(r.TANGGAL)
    return d.getMonth()===(month??now.getMonth())
  })
}

function buildSummary(rows){
  let total=0, out={}
  rows.forEach(r=>{
    out[r.KATEGORI]=(out[r.KATEGORI]||0)+Number(r.TOTAL)
    total+=Number(r.TOTAL)
  })
  return {out,total}
}

// 🧾 FORMAT STRUK
function formatStruk(d){
return `
🧾 *STRUK PENGELUARAN*

🏪 ${d.MERCHANT}
📅 ${d.TANGGAL}
⏰ ${d.JAM}
💰 Rp ${d.TOTAL.toLocaleString('id-ID')}
🏷️ ${d.KATEGORI}

Balas:
✅ Y | ❌ N
✏️ edit 5000
✏️ edit merchant Alfamart
`.trim()
}

/* ================= BOT ================= */
async function startBot(){
  const {state,saveCreds}=await useMultiFileAuthState('./auth')
  const sock=makeWASocket({
    auth:state,
    logger:Pino({level:'silent'})
  })

  sock.ev.on('creds.update',saveCreds)

  sock.ev.on('connection.update',({connection,qr,lastDisconnect})=>{
    if(qr) qrcode.generate(qr,{small:true})
    if(connection==='open') console.log('✅ BOT TERHUBUNG')
    if(connection==='close' &&
      lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut){
      console.log('🔁 reconnect')
      startBot()
    }
  })

  sock.ev.on('messages.upsert',async({messages,type})=>{
    if(type!=='notify') return
    const msg=messages[0]
    if(!msg.message||msg.key.fromMe) return
    const from=msg.key.remoteJid
    const text=msg.message.conversation

    /* ===== SUMMARY ===== */
    if(text?.startsWith('summary')){
      const m=text.split(' ')[1]
      const rows=await getMonthlyRows(MONTHS[m])
      if(!rows.length) return sock.sendMessage(from,{text:'📭 kosong'})
      const {out,total}=buildSummary(rows)
      let r='📊 *SUMMARY*\n\n'
      for(const k in out) r+=`• ${k}: Rp ${out[k].toLocaleString('id-ID')}\n`
      r+=`\n💰 TOTAL: Rp ${total.toLocaleString('id-ID')}`
      return sock.sendMessage(from,{text:r})
    }

    /* ===== CONFIRM ===== */
    if(pendingConfirm[from] && text){
      if(text==='Y'){
        await saveToSheet(pendingConfirm[from])
        delete pendingConfirm[from]
        return sock.sendMessage(from,{text:'✅ Tersimpan'})
      }
      if(text==='N'){
        delete pendingConfirm[from]
        return sock.sendMessage(from,{text:'❌ Dibatalkan'})
      }
    }

    /* ===== IMAGE OCR ===== */
    if(msg.message.imageMessage){
      const buffer=await downloadMediaMessage(msg,'buffer')
      const file=path.join(IMAGE_DIR,Date.now()+'.jpg')
      fs.writeFileSync(file,buffer)

      const {data}=await Tesseract.recognize(file,'ind')
      const total=extractTotalFinal(data.text)
      if(!total) return sock.sendMessage(from,{text:'❌ Total gagal dibaca'})

      const dt=extractDateTime(data.text)
      pendingConfirm[from]={
        TANGGAL:dt.toLocaleDateString('id-ID'),
        JAM:dt.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}),
        MERCHANT:extractMerchantOCR(data.text),
        TOTAL:total,
        KATEGORI:detectCategory(data.text)
      }
      return sock.sendMessage(from,{text:formatStruk(pendingConfirm[from])})
    }
  })
}

startBot()