require('dotenv').config();
const cron = require('node-cron');
const express = require('express');
const { LineBotClient, middleware } = require('@line/bot-sdk');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const client = LineBotClient.fromChannelAccessToken({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
});

const app = express();
app.set('etag', false);   // ปิด ETag ทั้งแอป กัน browser แคช API response
// --- ตั้งค่าเวลาเปิด-ปิดร้าน ---
const SHOP_OPEN_HOUR = 9;    // เปิด 9 โมงเช้า
const SHOP_CLOSE_HOUR = 3;  // ปิด 2 ทุ่ม (20:00)
const LAST_BOOKING_BUFFER_MIN = 30; // หยุดรับจองก่อนปิดร้าน 30 นาที กันลูกค้าจองแล้วไม่ทันคิว

function isShopAcceptingBookings() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const hour = now.getHours();
  const minute = now.getMinutes();
  const currentMinutesOfDay = hour * 60 + minute;
  
  const openMinutes = SHOP_OPEN_HOUR * 60; // 09:00 = 540 นาที
  
  // ปิดรับจองก่อนตี 3 (03:00) อยู่ 30 นาที = 02:30 น. (หรือ 150 นาทีของวันใหม่)
  const closeHourBuffer = SHOP_CLOSE_HOUR * 60 - LAST_BOOKING_BUFFER_MIN; 
  
  // กรณีร้านเปิดข้ามวัน (เปิด 9 โมงเช้า - ปิดตี 3 ของวันถัดไป)
  // ช่วงเวลาที่รับจองคือ: ตั้งแต่ 09:00 น. เป็นต้นไป จนถึงก่อน 02:30 น. ของวันใหม่
  
  // ถ้าระหว่าง 09:00 น. ถึง 23:59 น. (นาทีที่ 540 ถึง 1439)
  const isNormalDayTime = currentMinutesOfDay >= openMinutes;
  
  // ถ้าระหว่าง 00:00 น. ถึง 02:30 น. ของวันใหม่ (นาทีที่ 0 ถึง 150)
  const isEarlyMorningTime = currentMinutesOfDay <= closeHourBuffer;

  return isNormalDayTime || isEarlyMorningTime;
}
// --- Database setup ---
const adapter = new JSONFile('db.json');
const db = new Low(adapter, { queues: [], avgServiceTime: 8 }); // avgServiceTime หน่วยเป็นนาที

async function initDB() {
  await db.read();
  db.data ||= { queues: [], avgServiceTime: 8 };
  await db.write();
}
initDB();

// --- Serve static files (LIFF pages) ---
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store');
  },
}));

// หมายเหตุสำคัญ: ห้ามใส่ app.use(express.json()) แบบ global ตรงนี้!
// เพราะจะไปแย่งอ่าน body ของ request ก่อนที่ middleware ของ LINE จะตรวจสอบลายเซ็น (signature)
// ทำให้ webhook verify ล้มเหลว (500 error) — ใส่ express.json() เฉพาะ route ที่ต้องใช้ req.body แทน (เช่น /api/book)

// --- Webhook endpoint (LINE จะยิงมาที่นี่เมื่อมีข้อความ/event) ---
app.post('/webhook', middleware({ channelSecret: process.env.CHANNEL_SECRET }), async (req, res) => {
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
  res.json({ status: 'ok' });
});
app.post('/api/book', express.json(), async (req, res) => {
  if (!isShopAcceptingBookings()) {
    return res.status(400).json({
      error: `ขออภัย ขณะนี้ร้านปิดรับคิวแล้ว เปิดให้บริการ ${SHOP_OPEN_HOUR}:00 - ${SHOP_CLOSE_HOUR}:00 น.`
    });
  }
  const { userId, displayName, service, location } = req.body;
  await db.read();

  const waitingCount = db.data.queues.filter(q => q.status === 'waiting').length;
  const estimatedWait = waitingCount * db.data.avgServiceTime;

  const newQueue = {
    id: uuidv4(),
    queueNumber: db.data.queues.length + 1,
    userId,
    displayName,
    service,
    location,          // { lat, lng } หรือ null
    status: 'waiting',  // waiting | called | done | no-show
    bookedAt: Date.now(),
    calledAt: null,
  };
  

  db.data.queues.push(newQueue);
  await db.write();

  res.json({ queueNumber: newQueue.queueNumber, estimatedWait });
});

function updateAvgServiceTime(queue) {
  const durationMinutes = (Date.now() - queue.calledAt) / 60000;
  db.data.avgServiceTime = db.data.avgServiceTime * 0.7 + durationMinutes * 0.3;
}
function calculateDistanceKm(loc1, loc2) {
  const R = 6371;
  const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
  const dLng = (loc2.lng - loc1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
    Math.cos(loc1.lat * Math.PI/180) * Math.cos(loc2.lat * Math.PI/180) *
    Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const SHOP_LOCATION = { lat: 13.746126202713947, lng: 100.54070215894407 }; // ⚠️ ต้องแก้เป็นพิกัดร้านจริง 13.746126202713947, 100.54070215894407

function getTravelBufferMinutes(customerLocation) {
  if (!customerLocation) return 5;
  const distanceKm = calculateDistanceKm(customerLocation, SHOP_LOCATION);
  return Math.ceil((distanceKm / 20) * 60) + 5;
}

app.get('/api/debug/buffer', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (isNaN(lat) || isNaN(lng)) {
    return res.json({ note: 'ไม่ได้ส่งพิกัดมา ใช้ค่า default', bufferMinutes: getTravelBufferMinutes(null) });
  }

  const location = { lat, lng };
  const distanceKm = calculateDistanceKm(location, SHOP_LOCATION);
  const bufferMinutes = getTravelBufferMinutes(location);

  res.json({
    distanceKm: distanceKm.toFixed(2),
    bufferMinutes
  });
});

cron.schedule('* * * * *', async () => {
  console.log('⏰ cron ทำงาน:', new Date().toLocaleTimeString());
  await db.read();
  const waitingQueues = db.data.queues.filter(q => q.status === 'waiting');
  console.log('คิวที่รออยู่:', waitingQueues.length);

  for (let index = 0; index < waitingQueues.length; index++) {
    const q = waitingQueues[index];
    const estimatedWaitMin = index * db.data.avgServiceTime;
    const bufferMin = getTravelBufferMinutes(q.location);

    if (!q.notified && estimatedWaitMin <= bufferMin) {
      await client.pushMessage({
        to: q.userId,
        messages: [{
          type: 'text',
          text: `คิว #${q.queueNumber} ของคุณใกล้ถึงแล้ว (เหลืออีกประมาณ ${Math.round(estimatedWaitMin)} นาที) เตรียมตัวมาที่ร้านได้เลย 🏃`,
        }],
      });
      q.notified = true;
    }
  }

  await db.write();
});

app.get('/api/queues', async (req, res) => {
  await db.read();
  res.json(db.data.queues.filter(q => q.status !== 'done'));
});

app.post('/api/reset', async (req, res) => {
  db.data.queues = [];
  db.data.avgServiceTime = 8;   // รีเซ็ตค่าเฉลี่ยกลับเป็นค่าเริ่มต้นด้วย
  await db.write();
  res.json({ ok: true, message: 'รีเซ็ตคิว' });
});

app.post('/api/call/:id', async (req, res) => {
  await db.read();
  const queue = db.data.queues.find(q => q.id === req.params.id);
  queue.status = 'called';
  queue.calledAt = Date.now();
  await db.write();

  await client.pushMessage({
    to: queue.userId,
    messages: [{
      type: 'text',
      text: `ถึงคิวของคุณแล้ว! #${queue.queueNumber} กรุณามาที่ร้านภายใน 10 นาทีนะคะ`,
    }],
  });

  // ตั้งเวลาเช็ค no-show หลัง 5 นาที
  setTimeout(() => checkNoShow(queue.id), 15 * 1000);

  res.json({ ok: true });
});

app.post('/api/finish/:id', async (req, res) => {
  await db.read();
  const queue = db.data.queues.find(q => q.id === req.params.id);
  updateAvgServiceTime(queue);
  queue.status = 'done';
  await db.write();
  res.json({ ok: true });
});

async function checkNoShow(queueId) {
  await db.read();
  const queue = db.data.queues.find(q => q.id === queueId);
  if (queue.status === 'called') { // ยังไม่ถูกกด finish = ไม่มา
    queue.status = 'no-show';
    await db.write();

    await client.pushMessage({
      to: queue.userId,
      messages: [{
        type: 'template',
        altText: 'คุณพลาดคิวแล้ว ต้องการจองใหม่ไหม?',
        template: {
          type: 'confirm',
          text: `คิว #${queue.queueNumber} ของคุณถูกข้ามเนื่องจากไม่มาตามเวลา ต้องการจองคิวใหม่ไหม?`,
          actions: [
            { type: 'postback', label: 'จองคิวใหม่', data: `rebook:${queueId}` },
            { type: 'postback', label: 'ไม่', data: `cancel:${queueId}` },
          ],
        },
      }],
    });
  }
}

async function handleRebook(oldQueueId, userId) {
  await db.read();
  const oldQueue = db.data.queues.find(q => q.id === oldQueueId);

  if (!oldQueue || oldQueue.resolved) {
    await client.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: 'คำขอนี้ถูกดำเนินการไปแล้ว' }],
    });
    return;
  }
  oldQueue.resolved = true;   // ทำเครื่องหมายกันกดซ้ำ

  const newQueue = {
    ...oldQueue,
    id: uuidv4(),
    queueNumber: db.data.queues.length + 1,
    status: 'waiting',
    bookedAt: Date.now(),
    calledAt: null,
    notified: false,
    resolved: false,
  };
  db.data.queues.push(newQueue);
  await db.write();

  await client.pushMessage({
    to: userId,
    messages: [{ type: 'text', text: `จองคิวใหม่ให้แล้ว คิวของคุณคือ #${newQueue.queueNumber}` }],
  });
}

async function handleCancel(oldQueueId, userId) {
  await db.read();
  const oldQueue = db.data.queues.find(q => q.id === oldQueueId);

  if (!oldQueue || oldQueue.resolved) {
    await client.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: 'คำขอนี้ถูกดำเนินการไปแล้ว' }],
    });
    return;
  }
  oldQueue.resolved = true;   // ทำเครื่องหมายกันกดซ้ำ
  await db.write();

  await client.pushMessage({
    to: userId,
    messages: [{ type: 'text', text: 'รับทราบค่ะ ขอบคุณที่ใช้บริการ 🙏 หากเปลี่ยนใจสามารถกลับมาจองคิวใหม่ได้ทุกเมื่อ' }],
  });
}

async function handleEvent(event) {
  try {
    if (event.type === 'postback') {
      const data = event.postback.data;
      const userId = event.source.userId;

      if (data.startsWith('rebook:')) {
        const queueId = data.split(':')[1];
        await handleRebook(queueId, userId);
      } else if (data.startsWith('cancel:')) {
        const queueId = data.split(':')[1];
        await handleCancel(queueId, userId);
      }
      return;
    }
  } catch (e) {
    console.error('handleEvent error:', e);
  }
}
app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});

module.exports = { db, client };