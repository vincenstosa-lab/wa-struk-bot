/* ================= SAFE GUARD ================= */
process.on('uncaughtException', err => console.error('❌ Uncaught:', err))
process.on('unhandledRejection', err => console.error('❌ Rejection:', err))

/* ================= IMPORT ================= */
const express = require('express')
const QRCode = require('qrcode')
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
const SHEET_ID = '1qjSndza2fwNhkQ6WzY9DGhunTHV7cllbs75dnG5I6r4'

for (const dir of [AUTH_DIR, IMAGE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/* ================= HTTP SERVER ================= */
const app = express()
let latestQR = null

app.get('/', (_, res) => res.send('✅ WA Struk Bot running'))
app.get('/qr', async (_, res) => {
  if (!latestQR) return res.send('❌ QR belum tersedia')
  res.send(`<img src="${await QRCode.toDataURL(latestQR)}" />`)
})
app.listen(process.env.PORT || 3000)

/* ================= GOOGLE CREDS ================= */
let CREDS = null
if (process.env.GOOGLE_CREDS_JSON_BASE64) {
  CREDS = JSON.parse(Buffer.from(process.env.GOOGLE_CREDS_JSON_BASE64, 'base64'))
}

/* ================= STATE ================= */
const pendingConfirm = {}
const armedUsers = {} // user yang sudah kirim "pingpong"
let starting = false

/* ================= OCR HELPERS ================= */
function extractTotal(text = '') {
  const lines = text.split('\n')
  for (const l of lines) {
    if (/total|jumlah|grand|bayar|amount/i.test(l)) {
      const n = l.replace(/\./g, '').match(/\d{3,}/g)
      if (n) return Number(n[n.length - 1])
    }
  }
  const fallback = text.replace(/\./g, '').match(/\d{4,}/g)
  return fallback ? Math.max(...fallback.map(Number)) : null
}

function extractMerchant(text = '') {
  return text.split('\n').map(l => l.trim()).filter(Boolean)[0]?.slice(0, 40) || 'Struk'
}

function detectCategory(text = '') {
  const t = text.toLowerCase()
  if (/alfamart|indomaret/.test(t)) return 'Belanja'
  if (/kopi|cafe|resto|warung|bakso|ayam|mie|nasi/.test(t)) return 'Makan & Minum'
  if (/grab|gojek|spbu|pertamina/.test(t)) return 'Transport'
  if (/apotek|klinik/.test(t)) return 'Kesehatan'
  if (/telkomsel|indosat|xl|tri/.test(t)) return 'Pulsa / Internet'
  return 'Lainnya'
}

/* ================= IMAGE PREPROCESSING ================= */
async function preprocessImage(filePath) {
  const processedImage = await sharp(filePath)
    .greyscale()               // Mengubah gambar menjadi grayscale
    .normalize()               // Menormalkan kontras
    .toBuffer()               // Mengubah menjadi buffer
  return processedImage
}

/* ================= FORMAT PREVIEW ================= */
function formatPreview(d) {
  return `
🧾 *HASIL*
🏪 ${d.MERCHANT}
📅 ${d.TANGGAL}
⏰ ${d.JAM}
💰 Rp ${d.TOTAL.toLocaleString('id-ID')}
📦 ${d.KATEGORI}

Balas:
Y / N
edit nominal
edit merchant
edit kategori
edit tanggal
`
}

/* ================= SAVE TO SHEET ================= */
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

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: 'silent' }),
    browser: ['WA Struk Bot', 'Chrome', '121']
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) latestQR = qr
    if (connection === 'close') {
      const r = lastDisconnect?.error?.output?.statusCode
      if (r === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
      }
      starting = false
      setTimeout(startBot, 5000)
    }
    if (connection === 'open') starting = false
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      ''

    /* ===== AKTIVASI PINGPONG ===== */
    if (/^pingpong$/i.test(text)) {
      armedUsers[from] = true
      return sock.sendMessage(from, {
        text: '🏓 Siap! Kirim gambar struk atau ketik manual sekarang.'
      })
    }

    /* ===== CONFIRM MODE (SUPER FLEX & SMART PARSING) ===== */
    if (pendingConfirm[from]) {
      const d = pendingConfirm[from]
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

      for (const line of lines) {

        // ===== KONFIRMASI =====
        if (/^y$/i.test(line)) {
          await saveToSheet(d)
          delete pendingConfirm[from]
          return sock.sendMessage(from, { text: '✅ TERSIMPAN' })
        }

        if (/^n$/i.test(line)) {
          delete pendingConfirm[from]
          return sock.sendMessage(from, { text: '❌ DIBATALKAN' })
        }

        // ============================== 
        // 🔥 NOMINAL (PRIORITAS PALING ATAS)
        // ==============================

        // 1️⃣ ANGKA DOANG → OVERRIDE TOTAL
        if (/^\d{3,}$/.test(line)) {
          d.TOTAL = Number(line)
          continue
        }

        // 2️⃣ edit nominal 5500 / nominal 5500 / total 5500
        if (/^(edit\s*)?(nominal|total)\s*\d+/i.test(line)) {
          const num = Number(line.replace(/\D/g, ''))
          if (num) d.TOTAL = num
          continue
        }

        // ==============================
        // 🏪 MERCHANT
        // ==============================
        if (/^(edit\s*)?(merchant|toko|store)\s+/i.test(line)) {
          d.MERCHANT = line.replace(/^(edit\s*)?(merchant|toko|store)/i, '').trim()
          continue
        }

        // ==============================
        // 📦 KATEGORI
        // ==============================
        if (/^(edit\s*)?(kategori|category)\s+/i.test(line)) {
          d.KATEGORI = line.replace(/^(edit\s*)?(kategori|category)/i, '').trim()
          continue
        }

        // ==============================
        // 📅 TANGGAL
        // ==============================
        if (/^(edit\s*)?(tanggal|date)\s+/i.test(line)) {
          d.TANGGAL = line.replace(/^(edit\s*)?(tanggal|date)/i, '').trim()
          continue
        }

        // AUTO TANGGAL
        if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(line)) {
          d.TANGGAL = line
        }
      }

      return sock.sendMessage(from, { text: formatPreview(d) })
    }

    /* ===== MANUAL INPUT ===== */
    if (/^manual/i.test(text)) {
      if (!armedUsers[from]) return

      const p = text.split(' ')
      const total = Number(p[1])
      const merchant = p[2] || 'Manual'
      const kategori = p[3] || 'Lainnya'
      const now = new Date()

      pendingConfirm[from] = {
        TANGGAL: now.toLocaleDateString('id-ID'),
        JAM: now.toLocaleTimeString('id-ID'),
        MERCHANT: merchant,
        TOTAL: total,
        KATEGORI: kategori
      }

      delete armedUsers[from] // Setelah dipakai, dikunci lagi

      return sock.sendMessage(from, { text: formatPreview(pendingConfirm[from]) })
    }

    /* ===== IMAGE OCR ===== */
    if (!msg.message.imageMessage) return

    try {
      if (!armedUsers[from]) return // Jika tidak pingpong, diam

      const buffer = await downloadMediaMessage(msg, 'buffer')
      const file = path.join(IMAGE_DIR, Date.now() + '.jpg')
      fs.writeFileSync(file, buffer)

      const processedImage = await preprocessImage(file)
      const { data } = await Tesseract.recognize(processedImage, 'eng+ind')
      const total = extractTotal(data.text)
      if (!total) throw new Error()

      const now = new Date()
      pendingConfirm[from] = {
        TANGGAL: now.toLocaleDateString('id-ID'),
        JAM: now.toLocaleTimeString('id-ID'),
        MERCHANT: extractMerchant(data.text),
        TOTAL: total,
        KATEGORI: detectCategory(data.text)
      }

      delete armedUsers[from] // Setelah diproses, dikunci lagi

      return sock.sendMessage(from, { text: formatPreview(pendingConfirm[from]) })
    } catch {
      delete armedUsers[from]
      return sock.sendMessage(from, { text: '❌ OCR gagal membaca struk' })
    }
  })
}

startBot()