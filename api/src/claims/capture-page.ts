const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Cabeceras de la página pública: sin caché, sin referer (el token va en la URL) y CSP estricta. */
export const CAPTURE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  'permissions-policy': 'camera=(self), geolocation=(self)',
};

export function captureErrorPage(title: string, message: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;padding:24px;color:#222}h1{font-size:20px}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`;
}

/**
 * Página de captura en vivo: abre la cámara trasera con getUserMedia (no hay acceso a
 * la galería), toma fotos desde el video, agrega GPS y hora del celular, y las sube.
 * Sin dependencias externas.
 */
export function capturePage(opts: { claimNumber: string; insurer: string; maxPhotos?: number }): string {
  const max = opts.maxPhotos ?? 8;
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Fotos del siniestro ${esc(opts.claimNumber)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#111;color:#fff}
header{padding:12px 16px;font-size:15px}main{padding:0 16px 24px}
video{width:100%;max-height:60vh;background:#000;border-radius:8px}
button{width:100%;padding:16px;margin-top:12px;font-size:17px;border:0;border-radius:8px;background:#1f7a4d;color:#fff}
button:disabled{background:#555}#thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
#thumbs img{width:72px;height:72px;object-fit:cover;border-radius:4px}#msg{margin-top:12px;font-size:14px;min-height:1.4em}
.warn{color:#ffcc66}.ok{color:#8fe3b0}
</style></head>
<body>
<header>${esc(opts.insurer)} · Siniestro ${esc(opts.claimNumber)}</header>
<main>
<video id="v" autoplay playsinline muted></video>
<button id="shot" disabled>Tomar foto</button>
<button id="send" disabled>Enviar fotos</button>
<div id="thumbs"></div>
<p id="msg">Permita el acceso a la cámara y a su ubicación.</p>
</main>
<script>
(function(){
  var MAX=${max}, photos=[], pos=null;
  var v=document.getElementById('v'), shot=document.getElementById('shot'), send=document.getElementById('send');
  var msg=document.getElementById('msg'), thumbs=document.getElementById('thumbs');
  function say(t,c){msg.textContent=t;msg.className=c||'';}
  if(navigator.geolocation){
    navigator.geolocation.watchPosition(function(p){pos=p.coords;},function(){say('Sin ubicación: active el GPS para dar validez a las fotos.','warn');},
      {enableHighAccuracy:true,maximumAge:10000,timeout:20000});
  }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){say('Su navegador no permite usar la cámara. Abra el enlace en Chrome o Safari.','warn');return;}
  navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false})
    .then(function(s){v.srcObject=s;shot.disabled=false;say('Apunte a los daños y toque "Tomar foto".');})
    .catch(function(){say('No se pudo abrir la cámara. Revise los permisos del navegador.','warn');});
  shot.onclick=function(){
    if(photos.length>=MAX){say('Máximo '+MAX+' fotos.','warn');return;}
    var c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
    c.getContext('2d').drawImage(v,0,0);
    var data=c.toDataURL('image/jpeg',0.85);
    photos.push({image_base64:data.split(',')[1],mime_type:'image/jpeg',captured_at:new Date().toISOString(),
      lat:pos?pos.latitude:undefined,lng:pos?pos.longitude:undefined,accuracy:pos?pos.accuracy:undefined});
    var img=document.createElement('img');img.src=data;thumbs.appendChild(img);
    send.disabled=false;say(photos.length+' foto(s) lista(s).');
  };
  send.onclick=function(){
    send.disabled=true;shot.disabled=true;say('Enviando…');
    var batch=photos.splice(0,5);
    fetch(location.pathname.replace(/\\/$/,'')+'/photos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({photos:batch})})
      .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
      .then(function(j){
        if(photos.length){send.onclick();return;}
        thumbs.innerHTML='';shot.disabled=false;
        say('Recibimos '+j.total_photos+' foto(s). Vuelva a WhatsApp y toque LISTO.','ok');
      })
      .catch(function(){photos=batch.concat(photos);send.disabled=false;shot.disabled=false;say('No se pudo enviar. Revise su conexión e intente de nuevo.','warn');});
  };
})();
</script>
</body></html>`;
}
