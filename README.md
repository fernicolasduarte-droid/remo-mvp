# Remo MVP - mapa y clima

Actualización para GitHub/Render.

Cambios:
- Agrega mapa de ruta con origen, destino y línea de recorrido.
- El backend devuelve geometría OSRM cuando está disponible.
- Si OSRM falla, el mapa muestra línea directa como fallback.
- Muestra contexto de clima/demanda más visible.
- Mantiene Cabify/DiDi como ingreso manual requerido.
- Mantiene Uber como ruta automatizada validada.

Render:
- Build Command: npm install
- Start Command: npm start
