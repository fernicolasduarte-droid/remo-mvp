# Remo MVP - actualización DiDi + ubicación precisa

Archivos para subir a GitHub/Render:
- package.json
- server.js
- index.html
- didi-test.html
- README.md

Render:
- Build Command: npm install
- Start Command: npm start

Cambios:
- DiDi: fallback asistido, copia solo destino y abre app por intent launcher.
- Ubicación: toma hasta 3 lecturas y usa la más precisa. Muestra precisión aproximada en metros.
- didi-test.html: página aislada para probar variantes de DiDi.
