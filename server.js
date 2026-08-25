const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const upload = multer({ dest: 'uploads/' });

let client = null;
let isReady = false;
let qrCode = null;

const DATA_DIR = path.join(__dirname, 'data');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

fs.ensureDirSync(DATA_DIR);

if (!fs.existsSync(CONTACTS_FILE)) {
  fs.writeJsonSync(CONTACTS_FILE, []);
}
if (!fs.existsSync(MESSAGES_FILE)) {
  fs.writeJsonSync(MESSAGES_FILE, []);
}

function initWhatsApp() {
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    qrCode = qr;
    console.log('امسح الكود التالي من واتساب:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    isReady = true;
    qrCode = null;
    console.log('تم الاتصال بواتساب بنجاح!');
  });

  client.on('authenticated', () => {
    console.log('تم المصادقة بنجاح!');
  });

  client.on('auth_failure', (msg) => {
    console.error('فشل المصادقة:', msg);
    isReady = false;
  });

  client.on('disconnected', (reason) => {
    console.log('تم قطع الاتصال:', reason);
    isReady = false;
    initWhatsApp();
  });

  client.initialize();
}

initWhatsApp();

app.get('/api/status', (req, res) => {
  res.json({
    isReady,
    hasQr: qrCode !== null,
    qrCode
  });
});

app.get('/api/contacts', (req, res) => {
  const contacts = fs.readJsonSync(CONTACTS_FILE);
  res.json(contacts);
});

app.post('/api/contacts', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'الاسم ورقم الهاتف مطلوبين' });
  }

  let cleanPhone = phone.replace(/[^0-9+]/g, '');
  if (!cleanPhone.startsWith('+')) {
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '+20' + cleanPhone.substring(1);
    } else {
      cleanPhone = '+20' + cleanPhone;
    }
  }

  const contacts = fs.readJsonSync(CONTACTS_FILE);
  const newContact = {
    id: Date.now(),
    name,
    phone: cleanPhone,
    createdAt: new Date().toISOString()
  };

  contacts.push(newContact);
  fs.writeJsonSync(CONTACTS_FILE, contacts);
  res.json(newContact);
});

app.delete('/api/contacts/:id', (req, res) => {
  const contacts = fs.readJsonSync(CONTACTS_FILE);
  const filtered = contacts.filter(c => c.id !== parseInt(req.params.id));
  fs.writeJsonSync(CONTACTS_FILE, filtered);
  res.json({ success: true });
});

app.post('/api/contacts/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'يرجى رفع ملف' });
  }

  const results = [];
  const filePath = req.file.path;

  fs.createReadStream(filePath)
    .pipe(csv())
    .on('data', (data) => {
      const keys = Object.keys(data);
      const nameKey = keys.find(k => k.toLowerCase().includes('name') || k.includes('الاسم'));
      const phoneKey = keys.find(k => k.toLowerCase().includes('phone') || k.toLowerCase().includes('tel') || k.includes('الهاتف'));

      if (nameKey && phoneKey) {
        let phone = data[phoneKey].replace(/[^0-9+]/g, '');
        if (!phone.startsWith('+')) {
          if (phone.startsWith('0')) {
            phone = '+20' + phone.substring(1);
          } else {
            phone = '+20' + phone;
          }
        }
        results.push({
          id: Date.now() + Math.random(),
          name: data[nameKey],
          phone,
          createdAt: new Date().toISOString()
        });
      }
    })
    .on('end', () => {
      const contacts = fs.readJsonSync(CONTACTS_FILE);
      const updated = [...contacts, ...results];
      fs.writeJsonSync(CONTACTS_FILE, updated);
      fs.removeSync(filePath);
      res.json({ imported: results.length, total: updated.length });
    });
});

app.post('/api/send-text', upload.single('media'), async (req, res) => {
  if (!isReady) {
    return res.status(400).json({ error: 'واتساب غير متصل' });
  }

  const { message, contacts } = req.body;
  const contactIds = JSON.parse(contacts);
  const allContacts = fs.readJsonSync(CONTACTS_FILE);
  const selectedContacts = allContacts.filter(c => contactIds.includes(c.id));

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const contact of selectedContacts) {
    try {
      const chatId = contact.phone.replace('+', '') + '@c.us';
      const personalizedMessage = message
        .replace(/{name}/g, contact.name)
        .replace(/{phone}/g, contact.phone);

      if (req.file) {
        const media = await MessageMedia.fromFilePath(req.file.path);
        await client.sendMessage(chatId, media, { caption: personalizedMessage });
      } else {
        await client.sendMessage(chatId, personalizedMessage);
      }

      sent++;
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      failed++;
      errors.push({ contact: contact.name, error: err.message });
    }
  }

  if (req.file) {
    fs.removeSync(req.file.path);
  }

  res.json({ sent, failed, errors });
});

app.post('/api/send-media', upload.single('media'), async (req, res) => {
  if (!isReady) {
    return res.status(400).json({ error: 'واتساب غير متصل' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'يرجى رفع ملف' });
  }

  const { caption, contacts } = req.body;
  const contactIds = JSON.parse(contacts);
  const allContacts = fs.readJsonSync(CONTACTS_FILE);
  const selectedContacts = allContacts.filter(c => contactIds.includes(c.id));

  let sent = 0;
  let failed = 0;
  const errors = [];

  const media = await MessageMedia.fromFilePath(req.file.path);

  for (const contact of selectedContacts) {
    try {
      const chatId = contact.phone.replace('+', '') + '@c.us';
      const personalizedCaption = caption
        .replace(/{name}/g, contact.name)
        .replace(/{phone}/g, contact.phone);

      await client.sendMessage(chatId, media, { caption: personalizedCaption });
      sent++;
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      failed++;
      errors.push({ contact: contact.name, error: err.message });
    }
  }

  fs.removeSync(req.file.path);
  res.json({ sent, failed, errors });
});

app.get('/api/templates', (req, res) => {
  const templates = fs.readJsonSync(MESSAGES_FILE);
  res.json(templates);
});

app.post('/api/templates', (req, res) => {
  const { name, message } = req.body;
  const templates = fs.readJsonSync(MESSAGES_FILE);
  const newTemplate = {
    id: Date.now(),
    name,
    message,
    createdAt: new Date().toISOString()
  };
  templates.push(newTemplate);
  fs.writeJsonSync(MESSAGES_FILE, templates);
  res.json(newTemplate);
});

app.delete('/api/templates/:id', (req, res) => {
  const templates = fs.readJsonSync(MESSAGES_FILE);
  const filtered = templates.filter(t => t.id !== parseInt(req.params.id));
  fs.writeJsonSync(MESSAGES_FILE, filtered);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`الخادم يعمل على: http://localhost:${PORT}`);
  console.log('في انتظار الاتصال بواتساب...');
});