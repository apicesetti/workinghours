# Horas de trabajo — Add-ins Geotab Drive + MyGeotab · v1.1

Seguimiento de las **horas fuera de la oficina de todos los operarios**, aunque no manejen, y de los **clientes visitados** en cada parada.

- **Drive** — cuando el chofer se identifica en un vehículo (llavero NFC o GO Focus), el teléfono le avisa para que cargue quién viaja con él. Durante la jornada marca quién se bajó y asigna el cliente de cada parada.
- **MyGeotab** — el supervisor ve las horas por operario, las jornadas sin tripulación cargada y las visitas por cliente. Puede completar o corregir desde la oficina y exportar a CSV.
- **Planilla diaria** — reemplaza la planilla en papel: odómetro inicial y final, km totales, km entre clientes, visitas (desde–hasta), acompañantes, hora de salida y de llegada. Se completa sola; el conductor la revisa y la **confirma** en Drive, y la oficina la ve, la exporta o la imprime.

No usa servidor propio: todo sale de `DriverChange` + `Trip` + `Zone` y se guarda en **AddInData**.

## Cómo funciona

```
Llavero / GO Focus ──► DriverChange ──┐
                                      ├──► Jornada (conductor + día) ──► horas por persona y planilla
Trip (viajes y paradas) ──────────────┤
Zone (base y clientes) ───────────────┤
StatusData (odómetro ajustado) ───────┤
AddInData (tripulación y clientes) ───┘   ◄── Drive (chofer) / MyGeotab (oficina)
```

| Concepto | Regla |
|---|---|
| **Identificación** | Cualquier `DriverChange` de una persona (`DriverKey`, `TripDriver`, …). `UnknownDriverId` se genera al apagar el vehículo y **no corta** la jornada. |
| **Jornada** | **Conductor + día local**, con todos los vehículos que manejó ese día. En cada vehículo, su tramo se corta si otra persona, o una llave de un grupo excluido (mantenimiento), se identifica en él. |
| **Horas fuera de oficina** | Desde el inicio de la jornada hasta el fin, **menos las paradas intermedias dentro de una zona base**. |
| **Viajes desde/hacia el domicilio** | Por defecto **no cuentan**. Si el vehículo durmió fuera de la base (el último viaje previo terminó en la casa), la jornada empieza al llegar al primer destino. Si el último viaje del día termina fuera de la base, la jornada termina al salir de la última parada de trabajo. Configurable para que cuenten. |
| **Cierre de jornada** | **No hace falta marcarlo**: el fin sale de los viajes. Lo que el conductor confirma es la planilla. |
| **Acompañantes** | Heredan la línea de tiempo del vehículo entre su hora de subida y de bajada. En la primera carga se cuentan desde la identificación; si se suman después, desde ese momento. |
| **Varias jornadas el mismo día** | Si una persona acompañó a dos conductores, sus intervalos se **unen**, no se suman: nunca se duplican horas. |
| **Paradas** | Cada viaje termina en una parada en su **destino** (`stopPoint`), que dura hasta el próximo viaje. Cuentan las de más de N minutos (configurable, 10 por defecto) fuera de la base. Si caen en una geocerca se sugiere como cliente; si no, el chofer elige del catálogo o escribe uno. |
| **Movimientos dentro del predio** | Las paradas consecutivas unidas por un movimiento corto (≤ 1000 m y ≤ 10 min, configurable) o dentro de la misma geocerca se toman como **una sola visita**, desde que llegó hasta que se fue del predio. |

## Planilla diaria

| Dato de la planilla | De dónde sale |
|---|---|
| **Odómetro inicial / final** | Odómetro **ajustado** de MyGeotab (`DiagnosticOdometerAdjustmentId`), el mismo que usa el add-in **Odómetro por día** ([ODOMETER_REPORT](https://github.com/apicesetti/ODOMETER_REPORT)), leído en el instante de salida y al final del último viaje de cada vehículo. Así los dos add-ins dan los mismos números. Si no se puede leer, se usa el odómetro de los viajes y se marca con `*`. |
| **Km recorridos totales** | Odómetro final − inicial (por vehículo, sumados). |
| **Km entre clientes** | Viajes que salen de la visita a un cliente y llegan a la de otro. No cuenta oficina → primer cliente ni último cliente → oficina/casa. |
| **Visitas (desde – hasta)** | Paradas con cliente (cargado por el conductor o por geocerca), con los movimientos dentro del predio agrupados. |
| **Acompañantes** | Los cargados en Drive, con hora de subida y bajada. |
| **Hora de salida** | Inicio del primer viaje con movimiento (≥ 100 m), y desde dónde: oficina, geocerca o domicilio/otro lugar. |
| **Hora de llegada** | Llegada a la última parada (las maniobras posteriores en el mismo lugar no cuentan), y a dónde: oficina o domicilio/otro lugar. |

En Drive, **Planilla** muestra todo armado; el conductor agrega observaciones y toca **Confirmar planilla**. Queda guardada una copia de lo confirmado (quién y cuándo), útil como registro para ISO 9001. Si después cambia algo (por ejemplo, un cliente), la planilla avisa que hay que reconfirmar. En MyGeotab, la pestaña **Planillas** muestra el estado (pendiente / confirmada / cambió después), exporta a CSV (una fila por vehículo) e imprime una hoja por planilla.

## Archivos

| Archivo | Qué es |
|---|---|
| `workingHoursDrive.html` + `scripts/drive.js` | Add-in de Drive (`DriveAppLink/`, `onStartup`). Sin dependencias externas: funciona offline. |
| `workingHours.html` + `scripts/panel.js` | Página de MyGeotab (Actividad → Horas de trabajo). |
| `scripts/shared.js` | Lógica común: jornadas, paradas, zonas, cálculo de horas, almacenamiento. |
| `build.py` → `dist/config-*.json` | Configuraciones para pegar en MyGeotab. |
| `tests/` | Tests de la lógica (Node) y recorridos completos en navegador con API simulado. |

## Instalación en intcesetti

1. **Publicar con GitHub Pages**: *Settings → Pages → Deploy from branch → `main` / root*. La URL queda en `https://apicesetti.github.io/workinghours/`. Si usás otra URL: `python build.py https://otra-url`.
2. **Agregar los dos add-ins** en *Administración → Sistema → Configuración del sistema → Add-Ins*, pegando cada JSON por separado:
   - `dist/config-mygeotab.json` → página "Horas de trabajo".
   - `dist/config-drive.json` → add-in de Drive con `onStartup`/`onShutdown`. Van separados para que el arranque en segundo plano aplique solo a Drive.
3. **Configurar desde la página** (pestaña *Configuración*, primero consultar un período):
   - **Operarios**: `Conductores` (incluye *Tecnicos de campo* y *Otros*).
   - **Grupos excluidos**: `Llaves de mantenimiento` y `Llaves sin asignar`.
   - **Zonas base**: la oficina de Buenos Aires 444. En intcesetti hay tres zonas sobre el mismo rectángulo; marcar las tres (buscar "Buenos Aires 4"): `Buenos Aires 444, Neuquén, Argentina` (dos, `b339B` y `b339D`) y `Buenos Aires 464, Q8300 Neuquén, Argentina` (`b33A8`).
   - **Tipos de zona de cliente**: vacío = cualquier zona que no sea base. **Conviene restringirlo**: intcesetti tiene 537 zonas, incluidas áreas grandes como "Ciudad - Neuquen 1/6" o "Ruta 22 Neuquén". Sin restringir, una parada en cualquier lugar de la ciudad se sugeriría como cliente.
   - **Clientes sin geocerca**: catálogo para elegir en Drive.
4. **Permisos de los choferes**. El perfil de seguridad con el que entran a Drive necesita poder **ver**:
   - *Cambios de conductor* (`DriverChange`) y *Viajes* (`Trip`),
   - *Zonas*, *Usuarios/Conductores* y *Grupos*,
   - *Datos de add-ins* (lectura y escritura; viene incluido en el perfil *Drive App User*).

   Si no puede listar usuarios, el add-in usa la lista de conductores de Drive.
5. En cada teléfono: iniciar sesión en Drive **una vez** y aceptar el permiso de notificaciones.

## Modelo de datos (AddInData, `addInId = aETg6OS_TD0uqoFHaLelHvg`)

`details = { type, date, key, rec }`. Los campos de primer nivel existen solo para filtrar con `whereClause`, que admite una condición, sin AND/OR, y exige `selectClause`. Así el teléfono trae solo ayer y hoy, no todo el historial. Si el servidor rechazara el filtro, el código cae solo al modo "traer todo y filtrar".

| `type` | Uno por | Campos de `rec` |
|---|---|---|
| `crew` | jornada | `key` (`AAAA-MM-DD\|driverId`; los de v1.0 con `AAAA-MM-DD\|deviceId\|driverId` se leen igual), `deviceId`, `deviceIds[]`, `driverId`, `identifiedAt`, `solo`, `members[]` (`userId`, `name`, `from`, `to`), `stops[]` (`tripId`, `from`, `to`, `zoneId`, `clients[]`, `noClient`), `planilla` (`confirmedAt`, `confirmedBy`, `signature`, `notes`, `snapshot`), `source` (drive/panel), `history[]` |
| `settings` | base | `operatorGroupIds`, `excludeGroupIds`, `baseZoneIds`, `clientZoneTypeIds`, `minStopMinutes`, `shortMoveMeters`, `shortMoveMinutes`, `commute` (exclude/include), `pollMinutes`, `clients[]` |

Cada registro respeta el límite de 10.000 caracteres: se recorta el historial si hace falta.

```python
# Consulta desde Python (p. ej. para PostgreSQL / Power BI)
recs = api.get("AddInData", search={"addInId": "aETg6OS_TD0uqoFHaLelHvg",
                                    "selectClause": "rec", "whereClause": 'date = "2026-10-28"'})
tripulaciones = [r["details"] for r in recs if r["details"]["type"] == "crew"]
```

## Offline

Todo lo que carga el chofer se guarda primero en el teléfono y se sincroniza cuando vuelve la señal. La sincronización se dispara al reabrir Drive, en el ciclo de revisión y al cerrar sesión (`onShutdown`, 15 s). Si el registro fue borrado en el servidor, se recrea. Las paradas necesitan conexión para leer los viajes; el resto funciona sin señal.

## Tests

```bash
TZ=America/Argentina/Buenos_Aires node --test tests/*.test.js   # lógica (19 tests)
cd tests/e2e && python3 run_drive.py && python3 run_panel.py && python3 run_sync_error.py   # navegador (requiere playwright)
```

Los tests de lógica usan datos reales de intcesetti del 28/10/2026: una llave de mantenimiento que corta la jornada de Canales en WP, y los viajes y odómetros de Falcon en OE para la planilla. Los recorridos en navegador fijan el reloj a las 18:30 para no depender de la hora en que se corren.

## A validar en dispositivos reales

- **Notificación**: que aparezca en Android e iOS (`api.mobile.notification.notify`). En iOS, con la app en segundo plano, puede llegar recién al abrir Drive.
- **GO Focus**: que el reconocimiento facial genere `DriverChange`. El código acepta cualquier tipo, pero no hay identificaciones por cámara en intcesetti para confirmarlo.
- **whereClause en AddInData**: probado contra el comportamiento documentado; si falla, el fallback lo cubre.
- **Permiso a StatusData**: el perfil de los choferes necesita ver datos del motor para leer el odómetro ajustado en Drive; si no, la planilla usa el odómetro de los viajes (avisa en pantalla).
