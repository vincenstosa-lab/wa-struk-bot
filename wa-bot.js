/* ================= SAFE GUARD ================= */
process.on('uncaughtException', err => console.error('❌ Uncaught:', err))
process.on('unhandledRejection', err => console.error('❌ Rejection:', err))

/* ================= IMPORT ================= */
const express = require('express')
const QRCode = require('qrcode')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} = require('@whiskeysockets/baileys')

const Pino = require('pino')
const fs = require('fs')
const path = require('path')
const Tesseract = require('tesseract.js')
const { GoogleSpreadsheet } = require('google-spreadsheet')

/* ================= PATH (FLY VOLUME) ================= */
const AUTH_DIR = '/data/auth'
const IMAGE_DIR = '/data/images'

;[AUTH_DIR, IMAGE_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
})

/* ================= HTTP ================= */
const app = express()

let latestQR = null

app.get('/', (_, res) => res.send('✅ WA Struk Bot running'))

app.get('/qr', async (_, res) => {
  if (!latestQR) {
    return res.send('❌ QR belum tersedia, tunggu bot connect')
  }

  const img = await QRCode.toDataURL(latestQR)
  res.send(`
    <html>
      <body style="display:flex;flex-direction:column;align-items:center">
        <h2>Scan QR WhatsApp</h2>
        <img src="${img}" />
        <p>WA → Linked Devices → Link a device</p>
      </body>
    </html>
  `)
})

app.listen(process.env.PORT || 3000)

/* ================= CONFIG ================= */
const SHEET_ID = '1qjSndza2fwNhkQ6WzY9DGhunTHV7cllbs75dnG5I6r4'

let CREDS = null
if (process.env.GOOGLE_CREDS_JSON_BASE64) {
  CREDS = JSON.parse(
    Buffer.from(process.env.GOOGLE_CREDS_JSON_BASE64, 'base64').toString()
  )
}

/* ================= STATE ================= */
const pendingConfirm = {}
let isStarting = false

/* ================= HELPERS ================= */
function extractTotalFinal(text = '') {
  const nums = text.match(/\d{4,}/g)
  return nums ? Math.max(...nums.map(Number)) : null
}

function cleanup(file) {
  try { file && fs.unlinkSync(file) } catch {}
}

/* ================= GOOGLE SHEET ================= */
async function saveToSheet(data) {
  if (!CREDS) return
  const doc = new GoogleSpreadsheet(SHEET_ID)
  await doc.useServiceAccountAuth(CREDS)
  await doc.loadInfo()
  await doc.sheetsByIndex[0].addRow(data)
}

/* ================= BOT ================= */
async function startBot() {
  if (isStarting) return
  isStarting = true

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    const sock = makeWASocket({
      auth: state,
      logger: Pino({ level: 'silent' })
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {

      if (qr) {
        latestQR = qr
        console.log('📸 QR updated (akses /qr)')
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp connected')
        latestQR = null
        isStarting = false
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode
        console.log('❌ Disconnected:', reason)

        if (reason === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          latestQR = null
        }

        isStarting = false
        setTimeout(startBot, 7000)
      }
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

      if (pendingConfirm[from]) {
        if (text === 'Y') {
          await saveToSheet(pendingConfirm[from])
          delete pendingConfirm[from]
          return sock.sendMessage(from, { text: '✅ Tersimpan' })
        }
        if (text === 'N') {
          delete pendingConfirm[from]
          return sock.sendMessage(from, { text: '❌ Dibatalkan' })
        }
      }

      if (!msg.message.imageMessage) return

      let file
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer')
        file = path.join(IMAGE_DIR, Date.now() + '.jpg')
        fs.writeFileSync(file, buffer)

        const { data } = await Tesseract.recognize(file, 'eng+ind')
        const total = extractTotalFinal(data.text)
        if (!total) throw new Error('Total not found')

        pendingConfirm[from] = {
          TANGGAL: new Date().toLocaleDateString('id-ID'),
          JAM: new Date().toLocaleTimeString('id-ID'),
          MERCHANT: 'Struk',
          TOTAL: total,
          KATEGORI: 'Lainnya'
        }

        cleanup(file)
        sock.sendMessage(from, {
          text: `🧾 Total Rp ${total.toLocaleString('id-ID')}\nSimpan? Y / N`
        })

      } catch {
        cleanup(file)
        sock.sendMessage(from, { text: '❌ OCR gagal' })
      }
    })

  } catch (e) {
    console.log('❌ Startup error:', e.message)
    isStarting = false
    setTimeout(startBot, 7000)
  }
}

startBot()
