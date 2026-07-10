# Remo - Ubicacion actual + Cabify mejorado + subte solo CABA

## Que cambia

1. Agrega una pantalla previa antes del permiso de ubicacion:
   - Explica por que Remo pide ubicacion.
   - Aclara que no se guarda.
   - Recien despues dispara el permiso real del navegador.

2. Cabify:
   - Copia SOLO el destino que el usuario busco en Remo.
   - Usa la ubicacion actual como origen recomendado.
   - Abre Cabify con fallback a Play Store.
   - Ya no copia origen + destino juntos.

3. Transporte publico:
   - El subte aparece solo si origen y destino estan dentro de CABA.
   - Fuera de CABA muestra colectivo / tren / combinaciones, sin subte.

## Archivos a reemplazar

Reemplazar:
- remo-backend/public/index.html
- remo-backend/src/server.js

## Luego correr

cd C:\Users\ferni\OneDrive\Escritorio\remo\remo-backend
npm run dev
