const fetch = require('node-fetch');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');

async function preprocess(input, output) {
  await sharp(input)
    .grayscale()
    .normalize()
    .threshold(150)
    .sharpen()
    .toFile(output);
}

function parseReceipt(text) {
  const lines = text.split('\n').map(l => l.trim());

  const totalLine = lines.find(l => /total/i.test(l));
  const total = totalLine?.match(/([\d,.]+)/)?.[1]?.replace(/,/g, '');

  const tanggalLine = lines.find(l => /\d{2}-\d{2}-\d{4}/.test(l));
  const tanggalMatch = tanggalLine?.match(
    /(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2}:\d{2})/
  );

  return {
    tanggal: tanggalMatch?.[1] || '',
    jam: tanggalMatch?.[2] || '',
    total: total ? Number(total) : 0,
    merchant: 'Alfamidi'
  };
}

async function sendToSheet(data) {
  const url = 'https://script.google.com/macros/s/AKfycbw3EPgHPfXS0gzsiSICS5I6mne9frHfgMds-B08Sr0Hi9xqeG6M_69QxDji0KkDOH4/exec'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  const result = await res.text();
  console.log('📤 Response Sheet:', result);
}

async function runOCR() {
  const inputImage = path.join(__dirname, '../images/temp/struk.jpg');
  const processedImage = path.join(__dirname, '../images/temp/processed.jpg');

  await preprocess(inputImage, processedImage);

  const result = await Tesseract.recognize(
    processedImage,
    'ind+eng',
    { psm: 6 }
  );

  const parsed = parseReceipt(result.data.text);
  console.log('==== PARSED DATA ====');
  console.log(parsed);

  await sendToSheet(parsed);
}

runOCR();
