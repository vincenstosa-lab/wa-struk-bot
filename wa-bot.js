/* ================= IMPORT ================= */
process.on('uncaughtException', err => console.error(err))
process.on('unhandledRejection', err => console.error(err))
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

/* ================= CONFIG ================= */
const SHEET_ID = '1qjSndza2fwNhkQ6WzY9DGhunTHV7cllbs75dnG5I6r4'
const CREDS = JSON.parse(process.env.GOOGLE_CREDS_JSON)

const IMAGE_DIR = './images'
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR)

/* ================= STATE ================= */
const pendingConfirm = {}
const lastSaved = {}

/* ================= DATE MAP ================= */
const MONTHS = {
  januari:0,februari:1,maret:2,april:3,mei:4,juni:5,
  juli:6,agustus:7,september:8,oktober:9,november:10,desember:11
}

/* ================= HELPERS ================= */

// ✅ TOTAL FINAL – PALING AKURAT STRUK TOKO
function extractTotalFinal(text='') {
  const lines = text.split('\n').map(l=>l.toLowerCase())

  // cari TOTAL PALING BAWAH
  for (let i = lines.length-1; i >= 0; i--) {
    if (/total(?!.*kembali|.*diskon|.*pajak)/i.test(lines[i])) {
      const nums = lines[i].match(/\d{1,3}([.,]\d{3})+/g)
      if (nums) {
        return parseInt(nums[nums.length-1].replace(/[.,]/g,''))
      }
    }
  }

  // fallback aman
  const nums = text.match(/\d{1,3}([.,]\d{3})+/g)
  if (!nums) return null
  return Math.max(...nums.map(n=>parseInt(n.replace(/[.,]/g,''))))
}

// ⏰ DATE & TIME DARI STRUK
function extractDateTime(text='') {
  text = text.toLowerCase()

  const patterns = [
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4}).{0,15}?(\d{1,2})[:.](\d{2})/,
    /(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+(\d{4})/
  ]

  for (const p of patterns) {
    const m = text.match(p)
    if (m) {
      if (isNaN(m[2])) {
        return new Date(m[3], MONTHS[m[2]], m[1])
      }
      return new Date(
        m[3].length === 2 ? '20'+m[3] : m[3],
        m[2]-1, m[1], m[4]||0, m[5]||0
      )
    }
  }
  return new Date()
}

// 🏪 MERCHANT LEVEL TOKO (ANTI STRUK BELANJA)
function extractMerchantOCR(text='') {
  const blacklist = /struk|receipt|transaksi|kasir|alamat|telp|npwp|terima kasih/i

  const candidates = text.split('\n')
    .map(l=>l.trim())
    .filter(l =>
      l.length > 5 &&
      !/\d/.test(l) &&
      !blacklist.test(l)
    )

  if (!candidates.length) return 'Merchant'

  // pilih PALING PANJANG
  return candidates.sort((a,b)=>b.length-a.length)[0]
}

// 📂 KATEGORI
function detectCategory(text='') {
  text = text.toLowerCase()
  if (/makan|jajan|kopi|resto|cafe/.test(text)) return 'Konsumsi'
  if (/alfamart|indomaret|belanja|minimarket/.test(text)) return 'Belanja'
  if (/grab|gojek|ojek|transport/.test(text)) return 'Transport'
  if (/pulsa|listrik|token|pln/.test(text)) return 'Utilitas'
  return 'Lainnya'
}

// 💾 GOOGLE SHEET
async function saveToSheet(data) {
  const doc = new GoogleSpreadsheet(SHEET_ID)
  await doc.useServiceAccountAuth(CREDS)
  await doc.loadInfo()
  await doc.sheetsByIndex[0].addRow(data)
}

/* ================= BOT ================= */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')

  const sock = makeWASocket({
    auth: state,
    logger: Pino({ level:'silent' }),
    browser:['Chrome','Windows','10']
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({connection,qr,lastDisconnect}) => {
    if (qr) qrcode.generate(qr,{small:true})
    if (connection==='open') console.log('✅ BOT TERHUBUNG')
    if (connection==='close' &&
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    ) startBot()
  })

  sock.ev.on('messages.upsert', async ({messages,type}) => {
    if (type!=='notify') return
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return
    const from = msg.key.remoteJid

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text

    /* ===== CONFIRM ===== */
    if (pendingConfirm[from] && text) {
      const cmd = text.toLowerCase()

      if (cmd === 'y') {
        await saveToSheet(pendingConfirm[from])
        lastSaved[from] = pendingConfirm[from]
        delete pendingConfirm[from]
        return sock.sendMessage(from,{text:'✅ DATA TERSIMPAN'})
      }

      if (cmd === 'n') {
        delete pendingConfirm[from]
        return sock.sendMessage(from,{text:'❌ DIBATALKAN'})
      }

      if (cmd.startsWith('edit ') && /\d/.test(cmd)) {
        const n = cmd.match(/\d+/g)?.join('')
        if (n) {
          pendingConfirm[from].TOTAL = parseInt(n)
          return sock.sendMessage(from,{
            text:`✏️ Total diubah → Rp ${parseInt(n).toLocaleString('id-ID')}\nBalas Y / N`
          })
        }
      }

      if (cmd.startsWith('edit merchant') || cmd.startsWith('edit toko')) {
        const m = cmd.replace(/edit merchant|edit toko/i,'').trim()
        if (m.length > 2) {
          pendingConfirm[from].MERCHANT =
            m.replace(/\b\w/g,l=>l.toUpperCase())
          return sock.sendMessage(from,{
            text:`✏️ Merchant diubah → ${pendingConfirm[from].MERCHANT}\nBalas Y / N`
          })
        }
      }
    }

    /* ===== MANUAL ===== */
    if (text && !pendingConfirm[from]) {
      const total = extractTotalFinal(text)
      if (!total) return

      const dt = extractDateTime(text)
      pendingConfirm[from] = {
        TANGGAL: dt.toLocaleDateString('id-ID'),
        JAM: dt.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}),
        MERCHANT: text.replace(/\d+/g,'').trim(),
        TOTAL: total,
        KATEGORI: detectCategory(text)
      }

      const d = pendingConfirm[from]
      return sock.sendMessage(from,{text:
`📌 *PENGELUARAN*
📅 ${d.TANGGAL} ${d.JAM}
🏪 ${d.MERCHANT}
💰 Rp ${d.TOTAL.toLocaleString('id-ID')}
📂 ${d.KATEGORI}

Balas: Y / N / edit 5500 / edit merchant nama`
      })
    }

    /* ===== OCR ===== */
    if (msg.message.imageMessage) {
      const buffer = await downloadMediaMessage(msg,'buffer')
      const file = path.join(IMAGE_DIR,Date.now()+'.jpg')
      fs.writeFileSync(file,buffer)

      const { data } = await Tesseract.recognize(file,'ind',{
        preserve_interword_spaces:1
      })

      const total = extractTotalFinal(data.text)
      if (!total) return sock.sendMessage(from,{text:'❌ Total tidak terbaca'})

      const dt = extractDateTime(data.text)
      pendingConfirm[from] = {
        TANGGAL: dt.toLocaleDateString('id-ID'),
        JAM: dt.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}),
        MERCHANT: extractMerchantOCR(data.text),
        TOTAL: total,
        KATEGORI: detectCategory(data.text)
      }

      const d = pendingConfirm[from]
      return sock.sendMessage(from,{text:
`📸 *HASIL STRUK*
🏪 ${d.MERCHANT}
📅 ${d.TANGGAL} ${d.JAM}
💰 Rp ${d.TOTAL.toLocaleString('id-ID')}
📂 ${d.KATEGORI}

Balas: Y / N / edit 5500 / edit merchant nama`
      })
    }
  })
}

startBot()
