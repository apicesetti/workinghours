# Horas de trabajo — Add-ins Geotab Drive + MyGeotab · v1.0

Seguimiento de las **horas fuera de la oficina de todos los operarios**, aunque no manejen, y de los **clientes visitados** en cada parada.

- **Drive** — cuando el chofer se identifica en un vehículo (llavero NFC o GO Focus), el teléfono le avisa para que cargue quién viaja con él. Durante la jornada marca quién se bajó y asigna el cliente de cada parada.
- **MyGeotab** — el supervisor ve las horas por operario, las jornadas sin tripulación cargada y las visitas por cliente. Puede completar o corregir desde la oficina y exportar a CSV.

No usa servidor propio: todo sale de `DriverChange` + `Trip` + `Zone` y se guarda en **AddInData**.

## Cómo funciona

```
Llavero / GO Focus ──► DriverChange ──┐
                                      ├──► Jornada (chofer + vehículo + día) ──► horas por persona
Trip (viajes y paradas) ──────────────┤
Zone (base y clientes) ───────────────┤
AddInData (tripulación y clientes) ───┘   ◄── Drive (chofer) / MyGeotab (oficina)
```

| Concepto | Regla |
|---|---|
| **Identificación** | Cualquier `DriverChange` de una persona (`DriverKey`, `TripDriver`, …). `UnknownDriverId` se genera al apagar el vehículo y **no corta** la jornada. |
| **Jornada** | Chofer + vehículo + día local. Se corta si otra persona, o una llave de un grupo excluido (mantenimiento), se identifica en el vehículo. |
| **Horas fuera de oficina** | Desde el inicio del primer viaje hasta el fin del último, **menos las paradas intermedias dentro de una zona base**. |
| **Acompañantes** | Heredan la línea de tiempo del vehículo entre su hora de subida y de bajada. En la primera carga se cuentan desde la identificación; si se suman después, desde ese momento. |
| **Dos vehículos el mismo día** | Los intervalos de una persona se **unen**, no se suman: nunca se duplican horas. |
| **Paradas** | Las de más de N minutos (configurable, 10 por defecto) fuera de la base. Si caen en una geocerca se sugiere como cliente; si no, el chofer elige del catálogo o escribe uno. |

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
   - **Zonas base**: la zona de la oficina/taller. **En intcesetti no encontré ninguna zona de oficina**: hay que crearla o elegir la existente.
   - **Tipos de zona de cliente**: vacío = cualquier zona que no sea base. Conviene restringirlo, porque intcesetti tiene 537 zonas y muchas no son clientes.
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
| `crew` | jornada | `key` (`AAAA-MM-DD\|deviceId\|driverId`), `deviceId`, `driverId`, `identifiedAt`, `solo`, `members[]` (`userId`, `name`, `from`, `to`), `stops[]` (`tripId`, `from`, `to`, `zoneId`, `clients[]`, `noClient`), `status`, `closedAt/By`, `source` (drive/panel), `history[]` |
| `settings` | base | `operatorGroupIds`, `excludeGroupIds`, `baseZoneIds`, `clientZoneTypeIds`, `minStopMinutes`, `pollMinutes`, `clients[]` |

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
TZ=America/Argentina/Buenos_Aires node --test tests/*.test.js   # lógica (12 tests)
cd tests/e2e && python3 run_drive.py && python3 run_panel.py && python3 run_sync_error.py   # navegador (requiere playwright)
```

Los tests de lógica usan identificaciones reales de intcesetti del 28/10/2026, por ejemplo una llave de mantenimiento que corta la jornada de Canales en WP.

## A validar en dispositivos reales

- **Notificación**: que aparezca en Android e iOS (`api.mobile.notification.notify`). En iOS, con la app en segundo plano, puede llegar recién al abrir Drive.
- **GO Focus**: que el reconocimiento facial genere `DriverChange`. El código acepta cualquier tipo, pero no hay identificaciones por cámara en intcesetti para confirmarlo.
- **whereClause en AddInData**: probado contra el comportamiento documentado; si falla, el fallback lo cubre.
