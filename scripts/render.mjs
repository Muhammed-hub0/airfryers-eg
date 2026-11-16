import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXCLUDED_BRANDS, MAX_PRICE, MIN_PRICE } from './config.mjs';
import { productKey } from './naming.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA_DIR = join(ROOT, 'data');
export const OUT_DIR = join(ROOT, 'public');

const emptyDash = '—';

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatPrice = (value) =>
  Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatDate = (value) => {
  const date = value ? new Date(value) : new Date();
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Africa/Cairo',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
};

// الصفوف اللي هتظهر: نشِطة + سعرها منطقي + عندها صورة + مش براند مستثنى
export function visibleOffers(offers) {
  const list = offers
    .filter((o) => o && o.active !== false)
    .filter((o) => !EXCLUDED_BRANDS.includes(String(o.brand || '').trim()))
    .filter((o) => Number.isFinite(Number(o.price)))
    .map((o) => ({ ...o, price: Number(o.price) }))
    .filter((o) => o.price >= MIN_PRICE && o.price <= MAX_PRICE)
    .filter((o) => typeof o.img === 'string' && /^https:\/\//.test(o.img))
    .sort((a, b) => a.price - b.price);

  // نفس المنتج بأكتر من ASIN → نخلي الأرخص بس
  const seen = new Set();
  const rows = [];
  for (const offer of list) {
    const key = productKey(offer);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(offer);
  }
  return rows;
}

function filterScript() {
  return `(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#tbl tbody tr'));
  var fBrand = document.getElementById('fBrand');
  var fCap = document.getElementById('fCap');
  var fWatt = document.getElementById('fWatt');
  var fMin = document.getElementById('fMin');
  var fMax = document.getElementById('fMax');
  var cnt = document.getElementById('cnt');
  var total = rows.length;

  function fill(sel, attr, numeric) {
    var set = {};
    rows.forEach(function (r) { var v = r.getAttribute(attr); if (v) set[v] = 1; });
    var vals = Object.keys(set);
    vals.sort(numeric
      ? function (a, b) { return parseFloat(a) - parseFloat(b); }
      : function (a, b) { return a.localeCompare(b, 'ar'); });
    vals.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
  }
  fill(fCap, 'data-cap', true);
  fill(fWatt, 'data-watt', true);
  fill(fBrand, 'data-brand', false);

  function apply() {
    var b = fBrand.value, c = fCap.value, w = fWatt.value;
    var mn = parseFloat(fMin.value), mx = parseFloat(fMax.value);
    var shown = 0;
    rows.forEach(function (r) {
      var ok = (!b || r.getAttribute('data-brand') === b)
            && (!c || r.getAttribute('data-cap') === c)
            && (!w || r.getAttribute('data-watt') === w);
      var p = parseFloat(r.getAttribute('data-price'));
      if (!isNaN(mn)) { ok = ok && p >= mn; }
      if (!isNaN(mx)) { ok = ok && p <= mx; }
      r.style.display = ok ? '' : 'none';
      r.className = ok && (shown % 2 === 1) ? 'alt' : '';
      if (ok) { shown++; }
    });
    cnt.textContent = shown + ' من ' + total + ' منتج';
  }

  [fBrand, fCap, fWatt, fMin, fMax].forEach(function (el) {
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });
  document.getElementById('fReset').addEventListener('click', function () {
    fBrand.value = ''; fCap.value = ''; fWatt.value = ''; fMin.value = ''; fMax.value = '';
    apply();
  });
  apply();
})();`;
}

export function renderHtml(offers, options = {}) {
  const rows = visibleOffers(offers);
  const updatedAt = options.updatedAt || new Date().toISOString();

  const body = rows
    .map((offer, index) => {
      const warranty = esc(offer.warranty || '').replace(/\s\|\s/g, '<br>') || emptyDash;
      const ship = esc(offer.ship || '') || emptyDash;
      const cap = offer.cap ? esc(offer.cap) : emptyDash;
      const watt = offer.watt ? esc(offer.watt) : emptyDash;
      const url = esc(offer.url || '');
      const image = `<a href='${url}' target='_blank' rel='nofollow sponsored'><img src='${esc(
        offer.img,
      )}' loading='lazy' alt='${esc(offer.name)}' style='width:76px;height:76px;object-fit:contain'></a>`;
      return `<tr data-brand='${esc(offer.brand || '')}' data-cap='${esc(offer.cap || '')}' data-watt='${esc(
        offer.watt || '',
      )}' data-price='${offer.price}'><td class='n'>${index + 1}</td><td class='im'>${image}</td><td class='nm'>${esc(
        offer.name,
      )}</td><td class='sp'>${cap}</td><td class='sp'>${watt}</td><td class='w'>${warranty}</td><td>${ship}</td><td class='p'>${formatPrice(
        offer.price,
      )} ج.م</td><td class='lk'><a href='${url}' target='_blank' rel='nofollow sponsored'>افتح المنتج</a></td></tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>الإير فراير على أمازون مصر</title>
<style>
body{font-family:"Segoe UI",Tahoma,Arial,sans-serif;background:#f6f7f9;margin:0;padding:24px;color:#111}
h1{font-size:22px;margin:0 0 16px}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:12px 14px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.fld{display:flex;flex-direction:column;gap:4px}
.fld label{font-size:12px;color:#555}
select,input{font-family:inherit;font-size:14px;padding:7px 9px;border:1px solid #cfd6dd;border-radius:6px;background:#fff;min-width:130px}
input{min-width:100px}
button{font-family:inherit;font-size:14px;padding:8px 14px;border:1px solid #cfd6dd;border-radius:6px;background:#eef1f4;cursor:pointer}
button:hover{background:#e3e7eb}
.cnt{font-size:13px;color:#0b6b3a;font-weight:600;margin-inline-start:auto;padding-bottom:6px}
table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);font-size:14px}
th{background:#1f2937;color:#fff;padding:10px;text-align:right;position:sticky;top:0;z-index:1}
td{padding:8px 10px;border-bottom:1px solid #eceff1;vertical-align:top}
tr.alt td{background:#fafbfc}
.n{color:#888;width:36px}
.nm{font-weight:600}
.sp{white-space:nowrap;color:#333}
.p{font-weight:700;white-space:nowrap;color:#0b6b3a}
.w{color:#555;font-size:13px}
.im{width:90px;text-align:center}
a{color:#0b57d0;text-decoration:none}
a:hover{text-decoration:underline}
.ft{max-width:1100px;margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.7}
@media (max-width:720px){body{padding:12px}select,input{min-width:0;width:100%}.fld{flex:1 1 140px}.cnt{width:100%;margin-inline-start:0}}
</style></head><body>
<h1>الإير فراير على أمازون مصر</h1>
<div class="bar">
  <div class="fld"><label for="fBrand">البراند</label><select id="fBrand"><option value="">الكل</option></select></div>
  <div class="fld"><label for="fCap">السعة (لتر)</label><select id="fCap"><option value="">الكل</option></select></div>
  <div class="fld"><label for="fWatt">القدرة (وات)</label><select id="fWatt"><option value="">الكل</option></select></div>
  <div class="fld"><label for="fMin">السعر من</label><input id="fMin" type="number" inputmode="numeric" placeholder="0" min="0"></div>
  <div class="fld"><label for="fMax">السعر إلى</label><input id="fMax" type="number" inputmode="numeric" placeholder="∞" min="0"></div>
  <button id="fReset">مسح الفلاتر</button>
  <div class="cnt" id="cnt">${rows.length} من ${rows.length} منتج</div>
</div>
<table id="tbl">
<thead><tr><th></th><th>الصورة</th><th>الاسم</th><th>السعة (لتر)</th><th>القدرة (وات)</th><th>الضمان</th><th>الشحن</th><th>السعر</th><th>الرابط</th></tr></thead>
<tbody>
${body}
</tbody></table>
<div class="ft">
  <div>آخر تحديث تلقائي: ${esc(formatDate(updatedAt))} · ${rows.length} منتج</div>
  <div>كأفلييت أمازون: قد نحصل على عمولة من عمليات الشراء اللي بتحصل عن طريق روابط الصفحة، من غير أي تكلفة إضافية عليك. الأسعار والمقاسات بتتحدث تلقائيًا وقد تختلف لحظة الشراء.</div>
</div>
<script>
${filterScript()}
</script>
</body></html>
`;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function renderCsv(offers) {
  const rows = visibleOffers(offers);
  const lines = [
    ['م', 'الصورة', 'الاسم', 'البراند', 'السعة (لتر)', 'القدرة (وات)', 'الضمان', 'الشحن', 'السعر', 'الرابط'],
  ];

  rows.forEach((offer, index) => {
    lines.push([
      index + 1,
      offer.img || '',
      offer.name || '',
      offer.brand || '',
      offer.cap || '',
      offer.watt || '',
      offer.warranty || emptyDash,
      offer.ship || emptyDash,
      offer.price,
      offer.url || '',
    ]);
  });

  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

export async function writePublic(offers, options = {}) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'index.html'), renderHtml(offers, options), 'utf8');
  await writeFile(join(OUT_DIR, 'all-airfryers.csv'), renderCsv(offers), 'utf8');
  await writeFile(join(OUT_DIR, '.nojekyll'), '', 'utf8');
  return visibleOffers(offers).length;
}

async function main() {
  const raw = await readFile(join(DATA_DIR, 'offers.json'), 'utf8');
  const offers = JSON.parse(raw);
  const count = await writePublic(offers);
  console.log(`تم بناء الصفحة: ${count} منتج`);
}

if (process.argv[1] && process.argv[1].endsWith('render.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
