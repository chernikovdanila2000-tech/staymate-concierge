/* ============================================================
   StayAI — масове завантаження прайс-листа номерів (Блок 2)
   CSV/XLSX розбираються тут кодом (пошук колонок за словником
   синонімів укр/рос/англ). PDF/DOCX/фото — через Claude API,
   який повертає строго структурований JSON (tool-calling).
   Обидва шляхи повертають один і той самий формат рядка:
   { room_type, price_per_night, capacity, quantity, description,
     amenities, uncertain_fields }
   ============================================================ */

const XLSX = require('xlsx');
const mammoth = require('mammoth');

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 МБ — узгоджено з кабінетом

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';

/* ---------- 1. Розпізнавання колонок CSV/XLSX за словником синонімів ---------- */

const FIELD_SYNONYMS = {
  room_type: [
    'тип номера', 'тип номеру', 'тип', 'номер', 'назва номера', 'назва', 'название номера',
    'название', 'категорія', 'категория', 'room type', 'room', 'type', 'category', 'name',
  ],
  price_per_night: [
    'ціна за ніч', 'ціна/ніч', 'ціна', 'цена за ночь', 'цена/ночь', 'цена', 'вартість', 'стоимость',
    'price per night', 'price', 'rate', 'nightly rate', 'cost',
  ],
  capacity: [
    'місткість', 'вместимость', 'кількість гостей', 'количество гостей', 'гостей', 'осіб', 'человек',
    'персон', 'capacity', 'guests', 'max guests', 'occupancy', 'persons', 'pax',
  ],
  quantity: [
    'кількість номерів', 'кількість', 'количество номеров', 'количество', 'кол-во', 'к-сть', 'шт',
    'quantity', 'qty', 'count', 'rooms count', 'units',
  ],
  description: [
    'опис', 'описание', 'примітки', 'примечания', 'деталі', 'детали', 'description', 'notes', 'details',
  ],
  amenities: [
    'зручності', 'удобства', 'послуги', 'сервіси', 'сервисы', 'amenities', 'features', 'services',
  ],
};

function normalizeHeaderCell(cell) {
  return String(cell || '')
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[.,:;()\/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Синоніми проганяємо через ту саму нормалізацію, що й заголовки файлу —
// інакше "кол-во" (синонім) і "Кол-во" (заголовок у файлі, де дефіс
// заміниться на пробіл) перестають збігатись рядок-у-рядок.
const NORMALIZED_FIELD_SYNONYMS = Object.fromEntries(
  Object.entries(FIELD_SYNONYMS).map(([field, syns]) => [field, syns.map(normalizeHeaderCell)])
);

// Повертає {field, confidence:'high'|'medium'} для одного заголовка колонки,
// або null, якщо жоден канонічний field не підходить навіть частково.
function matchHeaderField(rawCell) {
  const norm = normalizeHeaderCell(rawCell);
  if (!norm) return null;

  for (const [field, synonyms] of Object.entries(NORMALIZED_FIELD_SYNONYMS)) {
    if (synonyms.includes(norm)) return { field, confidence: 'high' };
  }
  for (const [field, synonyms] of Object.entries(NORMALIZED_FIELD_SYNONYMS)) {
    if (synonyms.some((syn) => norm.includes(syn) || syn.includes(norm))) {
      return { field, confidence: 'medium' };
    }
  }
  return null;
}

/**
 * Розбирає CSV/XLSX/XLS у таблицю і намагається зіставити колонки.
 * Повертає null, якщо не вдалось впевнено знайти хоча б room_type і
 * price_per_night — тоді викликач має впасти на розпізнавання через Claude
 * (той самий шлях, що й для PDF/DOCX/фото), а не мовчки видати сміття.
 */
function parseSpreadsheet(buffer, ext) {
  // .csv must be decoded as UTF-8 text first — reading the raw bytes as
  // type:'buffer' makes SheetJS guess the wrong codepage and mangles any
  // non-ASCII header/cell (UA/RU room names turn into mojibake).
  const workbook = ext === '.csv'
    ? XLSX.read(buffer.toString('utf8'), { type: 'string' })
    : XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return null;

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!rows.length) return null;

  // Заголовок може бути не в першому рядку (буває порожній перший рядок
  // з назвою готелю) — переглядаємо перші 5 рядків і беремо той, що дає
  // найбільше впевнених збігів.
  let bestHeaderRowIdx = -1;
  let bestMapping = null;
  let bestScore = -1;

  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const mapping = {};
    let score = 0;
    rows[i].forEach((cell, colIdx) => {
      const match = matchHeaderField(cell);
      if (match && !(match.field in mapping)) {
        mapping[match.field] = { colIdx, confidence: match.confidence };
        score += match.confidence === 'high' ? 2 : 1;
      }
    });
    if (score > bestScore) {
      bestScore = score;
      bestMapping = mapping;
      bestHeaderRowIdx = i;
    }
  }

  if (!bestMapping || !('room_type' in bestMapping) || !('price_per_night' in bestMapping)) {
    return null; // недостатньо впевнено — хай розпізнає Claude
  }

  const dataRows = rows.slice(bestHeaderRowIdx + 1).filter((r) => r.some((c) => String(c || '').trim()));
  return { mapping: bestMapping, dataRows };
}

function parseAmenitiesCell(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s.split(/[,;|/]+/).map((x) => x.trim()).filter(Boolean);
}

function parseNumberCell(raw) {
  const s = String(raw || '').replace(/[^\d.,]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseIntCell(raw) {
  const n = parseNumberCell(raw);
  return n === null ? null : Math.round(n);
}

function rowsToRooms({ mapping, dataRows }) {
  const get = (row, field) => (mapping[field] ? row[mapping[field].colIdx] : undefined);

  return dataRows
    .map((row) => {
      const roomType = String(get(row, 'room_type') || '').trim();
      if (!roomType) return null;

      const price = parseNumberCell(get(row, 'price_per_night'));
      const capacityRaw = get(row, 'capacity');
      const quantityRaw = get(row, 'quantity');
      const capacity = capacityRaw !== undefined ? parseIntCell(capacityRaw) : null;
      const quantity = quantityRaw !== undefined ? parseIntCell(quantityRaw) : null;

      const uncertain = [];
      if (price === null) uncertain.push('price_per_night');
      if (capacity === null) uncertain.push('capacity');
      if (mapping.capacity && mapping.capacity.confidence === 'medium') uncertain.push('capacity');
      if (mapping.price_per_night.confidence === 'medium') uncertain.push('price_per_night');

      return {
        room_type: roomType,
        price_per_night: price === null ? 0 : price,
        capacity: capacity === null ? 2 : capacity,
        quantity: quantity === null ? 1 : quantity,
        description: String(get(row, 'description') || '').trim(),
        amenities: parseAmenitiesCell(get(row, 'amenities')),
        uncertain_fields: [...new Set(uncertain)],
      };
    })
    .filter(Boolean)
    .filter((r) => r.price_per_night > 0); // рядок без розпізнаної ціни марно показувати як номер
}

/* ---------- 2. Розпізнавання через Claude API (PDF/DOCX/фото + CSV-фолбек) ---------- */

const EXTRACT_TOOL = {
  name: 'extract_rooms',
  description: 'Повернути список номерів/апартаментів, розпізнаних із наданого прайс-листа чи документа.',
  input_schema: {
    type: 'object',
    properties: {
      rooms: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            room_type: { type: 'string', description: 'Назва/тип номера, як у документі' },
            price_per_night: { type: 'number', description: 'Ціна за ніч (число, без символу валюти)' },
            capacity: { type: 'integer', description: 'Максимальна кількість гостей (якщо не вказано — розумна оцінка, типово 2)' },
            quantity: { type: 'integer', description: 'Кількість фізичних номерів цього типу (якщо не вказано — 1)' },
            description: { type: 'string', description: 'Короткий опис номера, якщо є в документі' },
            amenities: { type: 'array', items: { type: 'string' }, description: 'Зручності/послуги, якщо перелічені' },
            uncertain_fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Назви полів (з-поміж capacity/quantity/description/amenities), значення яких не було явно вказано в документі і тому проставлено за замовчуванням',
            },
          },
          required: ['room_type', 'price_per_night'],
        },
      },
    },
    required: ['rooms'],
  },
};

const EXTRACT_SYSTEM_PROMPT = `Ти розпізнаєш прайс-лист номерів готелю з наданого документа чи фото.
Документ може бути українською, російською, англійською або сумішшю мов, з нестандартними назвами колонок
чи взагалі без таблиці (просто перелік з цінами в тексті).
Витягни ВСІ типи номерів, які там реально є.
НІКОЛИ не вигадуй ціну — якщо для рядка немає ціни, не включай цей рядок у відповідь.
Якщо capacity/quantity/опис/зручності не вказано явно — постав розумне значення за замовчуванням
(capacity: 2, quantity: 1) і обов'язково додай назву цього поля в uncertain_fields, щоб людина його перевірила.
Виклич інструмент extract_rooms рівно один раз з повним списком.`;

async function extractRoomsWithClaude(contentBlocks) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY не встановлено в змінних середовища.');
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: EXTRACT_SYSTEM_PROMPT,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_rooms' },
      messages: [{ role: 'user', content: contentBlocks }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API помилка ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const toolUse = data.content.find((b) => b.type === 'tool_use' && b.name === 'extract_rooms');
  if (!toolUse) throw new Error('Claude не повернув розпізнаний список номерів.');

  const rooms = Array.isArray(toolUse.input.rooms) ? toolUse.input.rooms : [];
  return rooms
    .filter((r) => r && r.room_type && typeof r.price_per_night === 'number' && r.price_per_night > 0)
    .map((r) => ({
      room_type: String(r.room_type).trim(),
      price_per_night: r.price_per_night,
      capacity: Number.isInteger(r.capacity) && r.capacity > 0 ? r.capacity : 2,
      quantity: Number.isInteger(r.quantity) && r.quantity > 0 ? r.quantity : 1,
      description: r.description ? String(r.description).trim() : '',
      amenities: Array.isArray(r.amenities) ? r.amenities.map(String) : [],
      uncertain_fields: Array.isArray(r.uncertain_fields) ? r.uncertain_fields : [],
    }));
}

const IMAGE_MEDIA_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

/**
 * Точка входу: розбирає завантажений файл (буфер + оригінальна назва) у
 * список номерів. Для CSV/XLSX спершу пробує код (parseSpreadsheet); якщо
 * впевнено розпізнати колонки не вдалось — падає на Claude, як і для решти
 * форматів.
 */
async function extractRoomsFromFile(buffer, filename) {
  const lower = String(filename || '').toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.'));

  if (ext === '.csv' || ext === '.xlsx' || ext === '.xls') {
    const parsed = parseSpreadsheet(buffer, ext);
    if (parsed) {
      const rooms = rowsToRooms(parsed);
      if (rooms.length) return { rooms, source: 'code' };
    }
    // Не впевнено розпізнали колонки коду — фолбек на Claude з тим самим
    // файлом як текстовою таблицею (CSV) чи описом.
    if (ext === '.csv') {
      const text = buffer.toString('utf8').slice(0, 20000);
      const rooms = await extractRoomsWithClaude([{ type: 'text', text: `Ось вміст CSV-файлу прайс-листа номерів:\n\n${text}` }]);
      return { rooms, source: 'claude-fallback' };
    }
    // .xlsx/.xls без впевнених колонок — конвертуємо в CSV-текст для Claude.
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const csvText = XLSX.utils.sheet_to_csv(sheet).slice(0, 20000);
    const rooms = await extractRoomsWithClaude([{ type: 'text', text: `Ось вміст таблиці Excel прайс-листа номерів (у форматі CSV):\n\n${csvText}` }]);
    return { rooms, source: 'claude-fallback' };
  }

  if (ext === '.pdf') {
    const rooms = await extractRoomsWithClaude([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: 'Розпізнай прайс-лист номерів із цього документа.' },
    ]);
    return { rooms, source: 'claude' };
  }

  if (ext === '.docx') {
    const { value: text } = await mammoth.extractRawText({ buffer });
    const rooms = await extractRoomsWithClaude([{ type: 'text', text: `Ось текст, витягнутий із документа Word із прайс-листом номерів:\n\n${text.slice(0, 20000)}` }]);
    return { rooms, source: 'claude' };
  }

  if (IMAGE_MEDIA_TYPES[ext]) {
    const rooms = await extractRoomsWithClaude([
      { type: 'image', source: { type: 'base64', media_type: IMAGE_MEDIA_TYPES[ext], data: buffer.toString('base64') } },
      { type: 'text', text: 'Розпізнай прайс-лист номерів на цьому фото/скані.' },
    ]);
    return { rooms, source: 'claude' };
  }

  throw new Error('Непідтримуваний тип файлу. Дозволено: CSV, XLSX, XLS, PDF, DOCX, JPG, PNG.');
}

/* ---------- 3. Пошук дублікатів серед уже наявних номерів готелю ---------- */

function normalizeRoomTypeKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function markDuplicates(parsedRooms, existingRooms) {
  const existingByKey = new Map();
  for (const room of existingRooms) {
    existingByKey.set(normalizeRoomTypeKey(room.room_type), room);
  }

  return parsedRooms.map((room) => {
    const match = existingByKey.get(normalizeRoomTypeKey(room.room_type));
    if (!match) return { ...room, is_duplicate: false };
    return {
      ...room,
      is_duplicate: true,
      existing_room_id: match.id,
      existing_room: {
        price_per_night: match.price_per_night,
        capacity: match.capacity,
        quantity: match.quantity,
        description: match.description,
      },
    };
  });
}

module.exports = {
  MAX_FILE_SIZE_BYTES,
  parseSpreadsheet,
  rowsToRooms,
  extractRoomsFromFile,
  extractRoomsWithClaude,
  markDuplicates,
  normalizeRoomTypeKey,
};
