"""Clientes (v1.3): llegada con la posición del teléfono en Drive, visitas y tramos del día,
y aprobación de la geocerca pedida en la página de MyGeotab."""
import pathlib, sys, datetime
from playwright.sync_api import sync_playwright

AR = datetime.timezone(datetime.timedelta(hours=-3))
FIXED_NOW = datetime.datetime.now(AR).replace(hour=11, minute=10, second=0, microsecond=0)
REPO = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).parent
OUT = HERE / 'shots'
OUT.mkdir(exist_ok=True)
errors = []

def check(cond, msg):
    print(('OK   ' if cond else 'FAIL ') + msg)
    if not cond:
        errors.append(msg)

SETTINGS = """() => {
  const S = WorkingHoursShared;
  const s = S.settingsRecord(Object.assign({}, S.DEFAULT_SETTINGS,
      { baseZoneIds: ['zBase'], operatorGroupIds: ['b2792'], clients: ['YPF Loma Campana', 'Pluspetrol'], newZoneTypeId: 'b55' }), 'admin');
  window.__db.AddInData.push({ id: 'aS1', addInId: S.ADDIN_ID, details: S.wrap(s) });
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 400, 'height': 860}, timezone_id='America/Argentina/Buenos_Aires', locale='es-AR')
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    page.on('console', lambda m: m.type == 'error' and errors.append('console: %s' % m.text))
    page.clock.set_fixed_time(FIXED_NOW)
    page.add_init_script(path=str(HERE / 'mockapi.js'))
    page.goto((REPO / 'workingHoursDrive.html').as_uri())
    page.evaluate(SETTINGS)
    # Falcon llega 11:00 a un lugar sin geocerca (destino de t3)
    page.evaluate("window.__phone = { lat: -39.5003, lon: -66.5002, acc: 12 }")
    page.evaluate("""() => new Promise(res => {
        const o = geotab.addin.workingHoursDrive();
        window.__addin = o;
        o.initialize(window.__api, window.__state, () => { o.focus(window.__api, window.__state); res(); });
    })""")
    page.wait_for_selector('.whd-card')
    page.click('[data-act=sec][data-key=clients]')
    page.wait_for_selector('[data-act=checkin]')
    page.wait_for_timeout(400)
    page.click('[data-act=checkin]')
    page.wait_for_timeout(300)
    hint = page.inner_text('.whd-hint')
    check('Ubicación del teléfono (±12 m)' in hint, 'toma la ubicación del teléfono (%s)' % hint)
    page.fill('#whd-search', 'Petrolera Sur')
    page.wait_for_timeout(100)
    check(page.is_visible('text=+ Cliente nuevo: «Petrolera Sur»'), 'ofrece crear cliente nuevo')
    check(page.evaluate("document.activeElement.id") == 'whd-search', 'el buscador no pierde el foco')
    page.screenshot(path=str(OUT / 'clients_1_checkin.png'), full_page=True)
    page.click('[data-act=checkinSave][data-new="1"]')
    page.wait_for_timeout(600)
    recs = [e['details']['rec'] for e in page.evaluate('window.__db.AddInData')]
    visits = [r for r in recs if r['type'] == 'visit']
    reqs = [r for r in recs if r['type'] == 'zonereq']
    check(len(visits) == 1 and visits[0]['client'] == 'Petrolera Sur' and visits[0]['clientNew'] and visits[0]['deviceId'] == 'b4', 'llegada guardada con vehículo')
    check(abs(visits[0]['lat'] + 39.5003) < 1e-6 and visits[0]['posSource'] == 'phone', 'con la posición del teléfono')
    check(len(reqs) == 1 and reqs[0]['status'] == 'pending', 'geocerca pedida (pendiente de aprobación)')
    page.wait_for_selector('.whd-visit')
    page.wait_for_timeout(300)
    txt = page.inner_text('#whd-view')
    print('      ', txt.replace('\n', ' | ')[:400])
    check('Cesetti - Batería 8 Tecpetrol-FDP' in txt and 'Petrolera Sur' in txt, 'visitas del día: la de geocerca y la registrada')
    check('11:00 – ahora' in txt and 'llegada registrada' in txt, 'la visita en curso termina sola (ahora)')
    check('↓ 30 min · 20,0 km' in txt, 'tramo entre clientes: tiempo y km')
    page.screenshot(path=str(OUT / 'clients_2_home.png'), full_page=True)

    # una llegada en otro lugar con geocerca cercana: no pide geocerca
    page.evaluate("window.__phone = { lat: -39.0433, lon: -67.5847, acc: 8 }")
    page.click('[data-act=checkin]')
    page.wait_for_timeout(300)
    near = page.locator('.whd-pick li').all_inner_texts()
    check(near and near[0].startswith('Cesetti - Batería 8') and 'Estás dentro' in near[0], 'sugiere la geocerca donde está (%s)' % near)
    check(page.evaluate("WorkingHoursShared.needsZone('Cesetti - Batería 8 Tecpetrol-FDP', { x: -67.5847, y: -39.0433 }, window.__db.Zone.map(WorkingHoursShared.compactZone), WorkingHoursShared.DEFAULT_SETTINGS)") is False, 'con geocerca existente no se pide otra')
    page.click('[data-act=home]')
    saved = page.evaluate('JSON.stringify(window.__db.AddInData)')

    # MyGeotab: el supervisor aprueba la geocerca
    page2 = ctx.new_page()
    page2.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    page2.clock.set_fixed_time(FIXED_NOW)
    page2.add_init_script(path=str(HERE / 'mockapi.js'))
    page2.set_viewport_size({'width': 1280, 'height': 900})
    page2.goto((REPO / 'workingHours.html').as_uri())
    page2.evaluate("(s) => { window.__db.AddInData = JSON.parse(s); window.__userName = 'supervisor@cesetti.com.ar'; }", saved)
    page2.evaluate("""() => new Promise(res => {
        const a = geotab.addin.workingHours();
        a.initialize(window.__api, {}, () => { a.focus(window.__api, {}); res(); });
    })""")
    page2.wait_for_selector('#wh-hours tr')
    page2.click('.wh-tab[data-tab=clients]')
    page2.wait_for_selector('#wh-zonereqs tr[data-req]')
    check('(1 pendiente)' in page2.inner_text('#wh-zonereqs-count'), 'una geocerca pendiente')
    vis = page2.inner_text('#wh-visits')
    check('Petrolera Sur' in vis and 'Llegada en Drive' in vis, 'la visita registrada aparece en el panel')
    legs = page2.inner_text('#wh-legs')
    check('Petrolera Sur' in legs and '30 min' in legs, 'tramo entre clientes en el panel (%s)' % legs.replace('\n', ' | ')[:200])
    page2.fill('[data-req-name]', 'Petrolera Sur - Base Añelo')
    page2.screenshot(path=str(OUT / 'clients_3_panel.png'), full_page=True)
    page2.click('[data-req-act=create]')
    page2.wait_for_timeout(500)
    zone = page2.evaluate("window.__db.Zone.filter(z => /^zN\d+$/.test(z.id))")
    check(len(zone) == 1 and zone[0]['name'] == 'Petrolera Sur - Base Añelo' and zone[0]['zoneTypes'] == [{'id': 'b55'}] and len(zone[0]['points']) == 5, 'geocerca creada en MyGeotab (100 × 100 m)')
    req = [e['details']['rec'] for e in page2.evaluate('window.__db.AddInData') if e['details']['type'] == 'zonereq'][0]
    check(req['status'] == 'created' and req['zoneId'] == zone[0]['id'] and req['resolvedBy'] == 'supervisor@cesetti.com.ar', 'pedido resuelto')
    check('Creada' in page2.inner_text('#wh-zonereqs'), 'figura como creada')
    b.close()

if errors:
    print('\n'.join(errors))
    sys.exit(1)
print('TODO OK')
