# San Rafael Sentinel

App para celular y PC que vigila el tiempo, los ríos y la cordillera para San Rafael (Mendoza) y avisa con anticipación. Combina 8 modelos del tiempo, 143 escenarios de ensamble, caudales GloFAS, climatología ERA5, satélite GOES e IMERG, alertas oficiales del SMN y el índice ENSO de NOAA. Todo con datos reales y la confianza explícita.

## Qué hace

- **Ahora**: qué puede pasar en las próximas 72 h, dónde, cuándo y con qué confianza. Cuatro amenazas: lluvia y anegamiento, tormenta y granizo, viento y Zonda, helada o calor. Cada una muestra el "por qué": cuántos modelos y escenarios superan cada umbral, y cuántos días por año pasa eso en ese punto.
- **Mapa**: tus puntos coloreados por la lluvia prevista, nubes del satélite GOES cada 10 min y lluvia satelital IMERG.
- **Ríos**: Diamante y Atuel a 30 días, antes y después de los embalses, comparados con su historia 1991-2020. Cordillera: lluvia, nieve, isoterma y lluvia sobre nieve. Contexto de El Niño y derrames de Irrigación.
- **Fuentes**: estado de cada fuente, permisos, puntos, umbrales y verificación.

Al abrirla por primera vez (también al abrir la versión instalada) pide la **ubicación en tiempo real**. Trae 28 puntos cargados con su fuente: tus 3 direcciones, el Hospital Schestakow, 17 distritos, embalses y nacientes.

## Límites que conviene saber

- Los niveles son **avisos preventivos calculados**, no alertas oficiales. Las alertas del SMN aparecen aparte, con su sello.
- Los modelos tienen celdas de 9 a 25 km. Comparan sectores; no ven una cuadra ni el drenaje de una calle.
- GloFAS es un modelo de caudal, no una medición. Aguas abajo de los diques manda la erogación, que el modelo no conoce.
- La ubicación en tiempo real funciona con la app abierta. Con la app cerrada vigila el **vigía** (abajo), que revisa tus puntos guardados.
- Calle Day 1532 está sobre la calle verificada, pero la altura no figura en OpenStreetMap. Fijala con el botón "Estoy acá".

## En la PC con Windows (ícono en el escritorio)

La carpeta `windows/` trae el lanzador. El ícono del escritorio ejecuta `windows/iniciar.ps1`, que:

1. Sirve la app solo en esta PC, en `http://localhost:8765` (la ubicación y el modo sin conexión necesitan una dirección así).
2. La abre en una ventana propia de Chrome o Edge, sin barra de navegador.
3. Trae en segundo plano la última versión publicada en GitHub (app y datos del vigía), como mucho una vez por hora.
4. Se apaga solo después de 3 horas sin uso.

Para la ubicación en la PC, Windows tiene que tener activado *Configuración → Privacidad → Ubicación*.

## Publicarla (gratis)

1. Creá un repositorio en GitHub y subí todos estos archivos (también la carpeta oculta `.github`).
   Si el repositorio es público, tus 3 direcciones quedan visibles en `js/points.js`. GitHub Pages en repositorios privados requiere un plan pago.
2. En **Settings → Pages**, elegí *Source: GitHub Actions*.
3. En **Settings → Secrets and variables → Actions**:
   - Secreto `NTFY_TOPIC`: un nombre largo e imposible de adivinar (por ejemplo `sentinel-sr-` y 12 letras al azar).
   - Variable `APP_URL`: la dirección que te da Pages (`https://TU-USUARIO.github.io/TU-REPO/`).
   - Variable opcional `VIGIA_PUNTOS`: ids de los puntos que vigila con la app cerrada. Por defecto: `bariloche-gaboto,rp160-rojo,day-1532,hospital`.
4. En **Actions → Vigía y publicación → Run workflow**. Desde ahí corre solo cada hora y publica la app.
5. En el celular: abrí la dirección, tocá *Instalar* (en iPhone: Compartir → Agregar a inicio) y permití la ubicación.
6. Para avisos con la app cerrada: instalá la app **ntfy** y suscribite a tu `NTFY_TOPIC`.

Para probarla en la PC sin publicar: `python3 -m http.server 8000` en esta carpeta y abrí `http://localhost:8000`.

## Fuentes y licencias

Open-Meteo (uso no comercial; ECMWF, NOAA, DWD, ECCC, UKMO, Météo-France, CMA, JMA, GloFAS/Copernicus, ERA5) · NASA GIBS · SMN Argentina, feed CAP (CC BY 4.0) · NOAA CPC · OpenStreetMap (ODbL) · GeoNames.
