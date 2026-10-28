"""Prueba de punta a punta de la página de MyGeotab con el API simulado."""
import pathlib, sys, csv, io
from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).parent
OUT = HERE / 'shots'
OUT.mkdir(exist_ok=True)
errors = []

def check(cond, msg):
    print(('OK   ' if cond else 'FAIL ') + msg)
    if not cond:
        errors.append(msg)

SEED = """() => {
  const S = WorkingHoursShared;
  const at = (h, m) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, m).toISOString(); };
  const today = S.dayKey(Date.now());
  const crew = S.newCrewRecord({ key: today + '|b4|b43F', date: today, deviceId: 'b4', driverId: 'b43F', firstAt: Date.parse(at(8, 24)) },
      { deviceName: 'OE', driverName: 'Mauricio Falcon', by: 'mf@cesetti.com.ar', source: 'drive' });
  crew.members = [
    { userId: 'b66', name: 'Cristian Vargas', from: at(8, 24), to: null },
    { userId: 'b6E', name: 'Braian Coñequeo', from: at(8, 24), to: at(11, 0) }
  ];
  crew.stops = [{ tripId: 't3', clients: ['YPF Loma Campana'] }];
  const settings = S.settingsRecord(Object.assign({}, S.DEFAULT_SETTINGS,
      { excludeGroupIds: ['b28E3', 'b284F'], baseZoneIds: ['zBase'], operatorGroupIds: ['b2792'], clients: ['YPF Loma Campana', 'Pluspetrol'] }), 'admin');
  window.__db.AddInData.push({ id: 'aS1', addInId: S.ADDIN_ID, details: S.wrap(settings) });
  window.__db.AddInData.push({ id: 'aC1', addInId: S.ADDIN_ID, details: S.wrap(crew) });
  window.__userName = 'supervisor@cesetti.com.ar';
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1280, 'height': 900}, timezone_id='America/Argentina/Buenos_Aires', locale='es-AR', accept_downloads=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    page.on('console', lambda m: m.type == 'error' and errors.append('console: %s' % m.text))
    page.add_init_script(path=str(HERE / 'mockapi.js'))
    page.goto((REPO / 'workingHours.html').as_uri())
    page.evaluate(SEED)
    page.evaluate("""() => new Promise(res => {
        window.__addin = geotab.addin.workingHours();
        window.__addin.initialize(window.__api, {}, () => { window.__addin.focus(window.__api, {}); res(); });
    })""")
    page.wait_for_selector('#wh-hours tr')
    page.wait_for_timeout(300)

    # --- Horas
    rows = {r.split('\t')[0].strip('▸ ').strip(): r.split('\t') for r in page.locator('#wh-hours tr').all_inner_texts()}
    print('      ', {k: v[3] for k, v in rows.items()})
    check('Llave de mantenimiento AR .' not in rows, 'la llave de mantenimiento no genera horas')
    check(rows.get('Mauricio Falcon', [''] * 8)[3] == '3 h 39 min', 'Falcon: 08:31–12:10 fuera de oficina')
    check(rows.get('Cristian Vargas', [''] * 8)[3] == '3 h 39 min', 'Vargas (acompañante toda la jornada) = chofer')
    check(rows.get('Braian Coñequeo', [''] * 8)[3] == '2 h 29 min', 'Coñequeo bajó 11:00 → 2 h 29 min')
    check(rows.get('Mariano Canales', [''] * 8)[3] == '2 h 20 min', 'Canales: jornada cortada por la llave de mantenimiento (08:50–11:10)')
    check(rows.get('Kevin Andrés', [''] * 8)[3] == '40 min', 'Andrés: solo su tramo')
    check(rows.get('Mariano Canales', [''] * 8)[7].strip() == '1', 'Canales tiene 1 jornada sin cargar')
    page.screenshot(path=str(OUT / 'panel_1_horas.png'), full_page=True)
    page.click('#wh-hours tr[data-user=b6E]')
    check(page.locator('#wh-hours .wh-sub-row').count() == 1, 'detalle por día al tocar el operario')

    # --- Jornadas
    page.click('.wh-tab[data-tab=jornadas]')
    jrows = page.locator('#wh-jornadas tr').all_inner_texts()
    check(len(jrows) == 3, 'tres jornadas (b4 Falcon, b3 Canales, b3 Andrés)')
    page.select_option('#wh-j-state', 'pending')
    check(page.locator('#wh-jornadas tr').count() == 2, 'filtro "sin tripulación" → 2')
    page.select_option('#wh-j-state', 'all')
    page.screenshot(path=str(OUT / 'panel_2_jornadas.png'), full_page=True)

    # Edición desde la oficina: Coñequeo también estuvo con Canales en WP (se superpone con OE)
    page.locator('#wh-jornadas tr', has_text='Mariano Canales').locator('[data-edit]').click()
    page.wait_for_selector('#wh-modal:not([hidden])')
    page.click('[data-m-add]')
    page.select_option('[data-m-user="0"]', 'b6E')
    page.fill('[data-m-from="0"]', '08:50')
    page.screenshot(path=str(OUT / 'panel_3_editar.png'), full_page=False)
    page.click('#wh-m-save')
    page.wait_for_selector('#wh-modal', state='hidden')
    page.wait_for_timeout(200)
    recs = page.evaluate("window.__db.AddInData.filter(e => e.details.type === 'crew').map(e => e.details.rec)")
    check(len(recs) == 2, 'se creó el registro de la jornada de Canales')
    canales = [r for r in recs if r['driverId'] == 'b7E'][0]
    check(canales['source'] == 'panel' and canales['history'][-1]['by'] == 'supervisor@cesetti.com.ar', 'queda registrado que se cargó desde la oficina y por quién')
    page.click('.wh-tab[data-tab=hours]')
    rows = {r.split('\t')[0].strip('▸▾ ').strip(): r.split('\t') for r in page.locator('#wh-hours > tr:not(.wh-sub-row)').all_inner_texts()}
    check(rows.get('Braian Coñequeo', [''] * 8)[3] == '2 h 39 min', 'Coñequeo en dos vehículos: 08:31–11:10 sin duplicar (%s)' % rows.get('Braian Coñequeo', [''] * 8)[3])

    # --- Clientes
    page.click('.wh-tab[data-tab=clients]')
    clients = [r.split('\t')[0] for r in page.locator('#wh-client-sum tr').all_inner_texts()]
    print('      clientes:', clients)
    check(set(clients) == {'Cesetti - Batería 8 Tecpetrol-FDP', 'YPF Loma Campana', 'Cesetti - Nippon'}, 'clientes: geocerca + cargado por el chofer')
    nip = page.locator('#wh-visits tr', has_text='Nippon').inner_text()
    check('Coñequeo' in nip and 'Canales' in nip, 'la visita lista a las personas presentes')
    page.screenshot(path=str(OUT / 'panel_4_clientes.png'), full_page=True)
    with page.expect_download() as dl:
        page.click('#wh-c-export')
    text = pathlib.Path(dl.value.path()).read_text(encoding='utf-8-sig')
    data = list(csv.reader(io.StringIO(text), delimiter=';'))
    check(data[0][0] == 'Fecha' and len(data) == 4, 'CSV de visitas (3 filas + encabezado)')

    # --- Configuración
    page.click('.wh-tab[data-tab=settings]')
    page.wait_for_selector('#wh-s-save')
    check(page.is_checked('[data-ex-group=b28E3]'), 'muestra los grupos excluidos guardados')
    check(page.is_checked('[data-base-zone=zBase]'), 'muestra la zona base guardada')
    page.fill('#wh-zone-search', 'nipp')
    page.wait_for_timeout(100)
    check(page.locator('[data-base-zone=zNip]').count() == 1, 'el buscador de zonas encuentra Nippon')
    page.fill('#wh-s-minstop', '15')
    page.screenshot(path=str(OUT / 'panel_5_config.png'), full_page=True)
    page.click('#wh-s-save')
    page.wait_for_timeout(300)
    st = page.evaluate("window.__db.AddInData.filter(e => e.details.type === 'settings')")
    check(len(st) == 1 and st[0]['details']['rec']['minStopMinutes'] == 15, 'configuración actualizada sin duplicar')
    check(st[0]['details']['rec']['baseZoneIds'] == ['zBase'], 'la zona base se conserva al guardar')
    b.close()

print()
print('ERRORES:' if errors else 'TODO OK', *errors, sep='\n  ')
sys.exit(1 if errors else 0)
