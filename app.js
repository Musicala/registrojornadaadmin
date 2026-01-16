// ====== Config ======
const GAS_URL = "https://script.google.com/macros/s/AKfycby3D1qtRlE9DdEcvCtSA5vxquBEndYpLjOYFJjsHdQ5YId4IwOky0mfW8AO53OimhLFcQ/exec"; // tu webapp
const ROLE = "administrativo";

// Local storage por rol (separa docentes vs admins si luego lo reutilizas)
const LS_KEY = `qr.registros.${ROLE}.v1`; // { name, cameraId, history: {YYYY-MM-DD:{ingreso?, salida?}} }

let html5QrCode = null;
let currentCameraId = null;
let SUBMIT_LOCK = false;

// ====== Helpers / DOM ======
const $ = (sel, ctx=document) => ctx.querySelector(sel);
const $reader = $("#reader");
const $cameraSelect = $("#cameraSelect");
const $persona = $("#practicanteSelect");
const $result = $("#result");
const $btnStart = $("#btnStart");
const $btnStop = $("#btnStop");
const $btnPerms = $("#btnPerms");
const $btnFlip = $("#btnFlip");
const $summary = $("#summary");
const $rolePill = $("#rolePill");
const $btnClearLocal = $("#btnClearLocal");

const loadState = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
};
const saveState = (data) => localStorage.setItem(LS_KEY, JSON.stringify(data));

function todayKey(d = new Date()){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function fmtTime(d = new Date()){
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}
function insecureContextMsg() {
  return !window.isSecureContext
    ? "Este sitio no está en HTTPS. En móviles, la cámara se bloquea sin HTTPS."
    : "";
}

async function fetchPeople(){
  const url = `${GAS_URL}?mode=meta&role=${encodeURIComponent(ROLE)}`;
  const res = await fetch(url, { method: "GET" });
  const data = await res.json().catch(()=>null);
  if (!data || !data.ok) throw new Error("No se pudo cargar la lista de miembros.");
  return Array.isArray(data.people) ? data.people : [];
}

function populatePeople(list){
  $persona.innerHTML = "";

  if (!list.length) {
    // Modo libre si no hay lista en la hoja
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Sin lista (edita hoja Miembros)";
    $persona.appendChild(opt);
    $persona.disabled = true;
    return;
  }

  $persona.disabled = false;
  list.forEach(n => {
    const opt = document.createElement("option");
    opt.value = n; opt.textContent = n;
    $persona.appendChild(opt);
  });
}

function pickBestCameraId(devices) {
  if (!devices || !devices.length) return null;
  const rear = devices.find(d => /back|trasera|rear|environment/i.test(d.label || ""));
  return (rear && rear.id) || devices[0].id;
}

// Usa html5-qrcode si está disponible; si falla, cae a enumerateDevices()
async function listVideoInputs() {
  try {
    const cams = await Html5Qrcode.getCameras();
    return cams.map(c => ({ id: c.id || c.deviceId, label: c.label }));
  } catch {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(d => d.kind === "videoinput")
      .map(d => ({ id: d.deviceId, label: d.label || "Cámara" }));
  }
}

async function populateCameras() {
  const devices = await listVideoInputs();
  $cameraSelect.innerHTML = "";

  if (!devices || !devices.length) {
    const msg = insecureContextMsg() || "No se detectaron cámaras. Revisa permisos del navegador.";
    $result.textContent = `⚠️ ${msg}`;
    return;
  }

  devices.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.label || `Cámara ${i+1}`;
    $cameraSelect.appendChild(opt);
  });

  const st = loadState();
  const remembered = st.cameraId && devices.find(d => d.id === st.cameraId);
  currentCameraId = remembered ? remembered.id : pickBestCameraId(devices);

  if (currentCameraId) $cameraSelect.value = currentCameraId;
}

async function requestPermissionsAndRefresh() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach(t => t.stop());
  } catch (e) {
    const msg = insecureContextMsg() || "Concede permiso a la cámara en el navegador.";
    $result.textContent = `⚠️ ${msg}`;
  } finally {
    await populateCameras();
  }
}

$cameraSelect.addEventListener("change", (e) => {
  currentCameraId = e.target.value;
  const st = loadState();
  st.cameraId = currentCameraId;
  saveState(st);
});

$persona.addEventListener("change", () => {
  const st = loadState();
  st.name = $persona.value;
  saveState(st);
  renderSummary();
});

$btnPerms.addEventListener("click", requestPermissionsAndRefresh);

$btnFlip.addEventListener("click", async () => {
  const options = Array.from($cameraSelect.options).map(o => o.value);
  if (options.length < 2) {
    $result.textContent = "No hay más cámaras detectadas para alternar.";
    return;
  }
  const idx = options.indexOf(currentCameraId);
  const nextId = options[(idx + 1) % options.length];
  $cameraSelect.value = nextId;
  currentCameraId = nextId;
  const st = loadState(); st.cameraId = nextId; saveState(st);

  if (html5QrCode && html5QrCode.isScanning) {
    await stop();
    await start();
  }
});

$btnClearLocal?.addEventListener("click", () => {
  const st = loadState();
  st.history = {};
  saveState(st);
  renderSummary();
  $result.textContent = "🧹 Histórico local borrado. (La Sheet no se toca)";
});

// ====== Escaneo ======
async function start() {
  try {
    if (!currentCameraId) await populateCameras();
    if (html5QrCode) await html5QrCode.stop().catch(()=>{});
    html5QrCode = new Html5Qrcode("reader");

    try {
      await html5QrCode.start(
        { deviceId: { exact: currentCameraId } },
        { fps: 10, qrbox: (vw, vh) => ({ width: Math.min(vw, vh) * 0.7, height: Math.min(vw, vh) * 0.7 }) },
        onScanSuccess,
        () => {}
      );
    } catch (err1) {
      await html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: (vw, vh) => ({ width: Math.min(vw, vh) * 0.7, height: Math.min(vw, vh) * 0.7 }) },
        onScanSuccess,
        () => {}
      );
    }

    $btnStart.disabled = true;
    $btnStop.disabled = false;

    const st = loadState();
    st.cameraId = currentCameraId;
    saveState(st);

  } catch (err) {
    const msg = insecureContextMsg() ||
      "Error al acceder a la cámara. Revisa permisos del sitio o cierra apps que usen la cámara y vuelve a intentar.";
    $result.textContent = `⚠️ ${msg}`;
  }
}

async function stop() {
  if (html5QrCode) {
    await html5QrCode.stop();
    await html5QrCode.clear();
    html5QrCode = null;
  }
  $btnStart.disabled = false;
  $btnStop.disabled = true;
}

$btnStart.addEventListener("click", start);
$btnStop.addEventListener("click", stop);

async function onScanSuccess(decodedText) {
  if (SUBMIT_LOCK) return;
  SUBMIT_LOCK = true;

  try {
    if (navigator.vibrate) navigator.vibrate(20);
    if (html5QrCode && html5QrCode.pause) html5QrCode.pause(true);

    const st = loadState();
    const name = ($persona?.value || st.name || "").trim();
    if (!name) {
      $result.textContent = "⚠️ Selecciona un nombre primero.";
      return;
    }

    const now = new Date();
    const dateISO = todayKey(now);
    const timeHHMM = fmtTime(now);

    $result.textContent = `Leyó: “${decodedText}” — ${dateISO} ${timeHHMM} — Enviando…`;

    const res = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        mode: "registro",
        payload: {
          role: ROLE,
          date: dateISO,
          name,
          stamp: now.toISOString(),
          raw: decodedText
        }
      })
    });

    const rawText = await res.text().catch(()=>"(sin cuerpo)");
    if (!res.ok) { $result.textContent = `❌ HTTP ${res.status} – ${rawText}`; return; }

    let data;
    try { data = JSON.parse(rawText); }
    catch { $result.textContent = `❌ Respuesta no JSON: ${rawText}`; return; }

    if (!data.ok) { $result.textContent = `❌ GAS dijo: ${data.error || "Error desconocido"}`; return; }

    const tipo = data.type === "salida" ? "Salida" :
                 data.type === "ingreso" ? "Ingreso" :
                 data.type;

    $result.textContent = `✔️ ${name} — ${tipo} registrado: ${dateISO} ${timeHHMM}`;

    st.name = name;
    st.history = st.history || {};
    st.history[dateISO] = st.history[dateISO] || {};
    if (data.type === "ingreso") st.history[dateISO].ingreso = timeHHMM;
    if (data.type === "salida")  st.history[dateISO].salida  = timeHHMM;

    saveState(st);
    renderSummary();

  } catch (err) {
    $result.textContent = `❌ Fetch falló (¿red?): ${String(err)}`;
  } finally {
    setTimeout(async () => {
      try { if (html5QrCode && html5QrCode.isScanning && html5QrCode.resume) html5QrCode.resume(); } catch(e){}
      SUBMIT_LOCK = false;
    }, 600);
  }
}

// ====== Render ======
function renderSummary(){
  const st = loadState();
  const k = todayKey();
  const h = (st.history && st.history[k]) || {};
  const nombre = ($persona?.value || st.name || "-");

  const rows = [
    `<div class="row header"><div>Fecha</div><div>Nombre</div><div>Ingreso</div><div>Salida</div></div>`,
    `<div class="row"><div>${k}</div><div>${nombre}</div><div>${h.ingreso || "-"}</div><div>${h.salida || "-"}</div></div>`
  ];
  $summary.innerHTML = rows.join("");
}

// ====== Init ======
document.addEventListener("DOMContentLoaded", async () => {
  if ($rolePill) $rolePill.textContent = ROLE;

  // 1) cargar lista desde Sheet (vía WebApp)
  try {
    const people = await fetchPeople();
    populatePeople(people);

    const st = loadState();
    if (st.name && !$persona.disabled) $persona.value = st.name;

  } catch (e) {
    console.error(e);
    $result.textContent = "⚠️ No se pudo cargar la lista desde la hoja Miembros. Revisa el GAS_URL o permisos.";
  }

  // 2) cámaras
  try {
    const st = loadState();
    if (st.cameraId) currentCameraId = st.cameraId;
    await populateCameras();
  } catch(e) {
    const msg = insecureContextMsg() || "Error listando cámaras. Revisa permisos del navegador.";
    $result.textContent = `⚠️ ${msg}`;
  }

  renderSummary();
});
