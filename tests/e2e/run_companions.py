"""Confirmación del acompañante y declaración "viajo con…" (v1.2), con el API simulado.

Cada persona usa su propio teléfono: se cambia el usuario de la sesión y se limpia el
almacenamiento local, pero la base (window.__db) es la misma.
"""
import pathlib, sys, datetime
from playwright.sync_api import sync_playwright

AR = datetime.timezone(datetime.timedelta(hours=-3))
FIXED_NOW = datetime.datetime.now(AR).replace(hour=11, minute=0, second=0, microsecond=0)
REPO = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).parent
OUT = HERE / 'shots'
OUT.mkdir(exist_ok=True)
errors = []

def check(cond, msg):
    print(('OK   ' if cond else 'FAIL ') + msg)
    if not cond:
        errors.append(msg)

def as_user(page, login):
    """Otro teléfono: otra sesión, sin caché local, misma base."""
    page.evaluate("""(login) => new Promise(res => {
        localStorage.clear();
        window.__userName = login;
        window.__notifications.length = 0;
        const s = geotab.addin.workingHoursDrive();
        s.startup(window.__api, window.__state, () => {
            const o = geotab.addin.workingHoursDrive();
            window.__addin = o;
            o.initialize(window.__api, window.__state, () => { o.focus(window.__api, window.__state); res(); });
        });
    })""", login)
    page.wait_for_timeout(500)

def recs(page, typ):
    return [e['details']['rec'] for e in page.evaluate('window.__db.AddInData') if e['details']['type'] == typ]

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 400, 'height': 820}, timezone_id='America/Argentina/Buenos_Aires', locale='es-AR')
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    page.on('console', lambda m: m.type == 'error' and errors.append('console: %s' % m.text))
    page.clock.set_fixed_time(FIXED_NOW)
    page.add_init_script(path=str(HERE / 'mockapi.js'))
    page.goto((REPO / 'workingHoursDrive.html').as_uri())

    # 1) Falcon (chofer de OE) carga a Vargas
    as_user(page, 'mf@cesetti.com.ar')
    page.click('[data-act=crew]')
    page.wait_for_selector('.whd-pick')
    page.check('[data-pick=b66]')
    page.click('[data-act=saveCrew]')
    page.wait_for_timeout(400)
    check(len(recs(page, 'crew')) == 1, 'tripulación guardada')
    check('Cristian Vargas · sin confirmar' in page.inner_text('.whd-idcard'), 'el chofer ve que falta la confirmación')

    # 2) el teléfono de Vargas: aviso y confirmación
    as_user(page, 'cv@cesetti.com.ar')
    n = page.evaluate('window.__notifications')
    check(any(x['title'] == '¿Viajás con Mauricio Falcon?' for x in n), 'Vargas recibe el aviso (%s)' % [x['title'] for x in n])
    check(page.is_visible('.whd-card-ask'), 'tarjeta para confirmar')
    page.screenshot(path=str(OUT / 'comp_1_invite.png'), full_page=True)
    page.click('[data-act=ack][data-status=ok]')
    page.wait_for_timeout(400)
    acks = recs(page, 'ack')
    check(len(acks) == 1 and acks[0]['status'] == 'ok' and acks[0]['userId'] == 'b66', 'confirmación guardada como registro aparte')
    check(not page.is_visible('.whd-card-ask'), 'la tarjeta desaparece')
    crew = recs(page, 'crew')[0]
    check(all('_ack' not in m for m in crew['members']), 'la tripulación del chofer no se tocó')

    # 3) Coñequeo declara "viajo con Falcon"
    page.evaluate("window.__dsi = [{ device: { id: 'b4' }, driver: { id: 'b43F' } }]")
    as_user(page, 'bnc@cesetti.com.ar')
    page.click('[data-act=claimStart]')
    page.wait_for_selector('.whd-pick')
    page.fill('#whd-search', 'falc')
    page.wait_for_timeout(100)
    names = page.locator('.whd-pick li').all_inner_texts()
    check(len(names) == 1 and names[0].startswith('Mauricio Falcon') and 'Identificado ahora en OE · AD229OE' in names[0], 'buscador de choferes con el vehículo (%s)' % names)
    check(page.evaluate("document.activeElement.id") == 'whd-search', 'el buscador no pierde el foco')
    page.screenshot(path=str(OUT / 'comp_2_claim.png'), full_page=True)
    page.click('[data-act=claimSave]')
    page.wait_for_timeout(400)
    cl = recs(page, 'claim')
    check(len(cl) == 1 and cl[0]['driverId'] == 'b43F' and cl[0]['status'] == 'pending', 'declaración guardada')
    check('esperando que confirme' in page.inner_text('#whd-view'), 'Coñequeo ve que está pendiente')

    # 4) Falcon recibe la declaración y la confirma
    as_user(page, 'mf@cesetti.com.ar')
    n = page.evaluate('window.__notifications')
    check(any(x['title'] == 'Braian Coñequeo dice que viaja con vos' for x in n), 'Falcon recibe el aviso')
    page.screenshot(path=str(OUT / 'comp_3_resolve.png'), full_page=True)
    page.click('[data-act=claimOk]')
    page.wait_for_timeout(500)
    crew = recs(page, 'crew')[0]
    m = [x for x in crew['members'] if x['userId'] == 'b6E']
    check(len(m) == 1 and m[0].get('viaClaim'), 'Coñequeo sumado a la tripulación por su declaración')
    check(recs(page, 'claim')[0]['status'] == 'accepted', 'declaración aceptada')
    card = page.inner_text('.whd-idcard')
    check('Braian Coñequeo' in card and 'sin confirmar' not in card, 'sin pendientes en la identificación (%s)' % card.replace('\n', ' | '))
    check(m[0].get('deviceId') == 'b4', 'el acompañante por declaración queda en el vehículo del chofer')
    page.screenshot(path=str(OUT / 'comp_4_done.png'), full_page=True)

    # 5) Kevin Andrés: Falcon lo carga y él dice "No viajo"
    page.click('[data-act=crew]')
    page.wait_for_selector('.whd-pick')
    page.check('[data-pick=b57]')
    page.click('[data-act=saveCrew]')
    page.wait_for_timeout(400)
    as_user(page, 'ka@cesetti.com.ar')
    page.click('[data-act=ack][data-status=no]')
    page.wait_for_timeout(400)
    as_user(page, 'mf@cesetti.com.ar')
    check('Kevin Andrés · dijo que no' in page.inner_text('.whd-idcard'), 'el chofer ve el rechazo')

    # 6) Drive vuelve a insertar el HTML al reabrir la página: los botones siguen andando
    page.evaluate("""() => { const o = document.getElementById('whDrive'); o.replaceWith(o.cloneNode(true)); window.__addin.focus(window.__api, window.__state); }""")
    page.wait_for_timeout(300)
    page.click('[data-act=crew]')
    page.wait_for_timeout(200)
    check(page.is_visible('.whd-pick'), 'botones activos después de reinsertar la página')
    page.click('[data-act=home]')
    page.wait_for_timeout(200)
    # 7) Falcon está identificado: no se le ofrece "Viajo con…" (es el chofer)
    check(page.locator('[data-act=claimStart]').count() == 0, 'el chofer identificado no ve "Viajo con…"')
    # 8) caso real: el chofer (Falcon) declaró "viajo con Conductor test", que no está identificado.
    #    Conductor test confirma → queda él como acompañante de Falcon
    page.evaluate("""() => { const S = WorkingHoursShared; const c = S.newClaim({ id: 'b43F', name: 'Mauricio Falcon' }, { id: 'b2A8', name: 'Conductor test' }, { at: Date.now() - 30 * 60000 });
        window.__db.AddInData.push({ id: 'aCl', addInId: S.ADDIN_ID, details: S.wrap(c) }); }""")
    as_user(page, 'conductor_test')
    check(page.is_visible('text=Mauricio Falcon dice que viaja con vos'), 'Conductor test recibe la declaración')
    page.click('[data-act=claimOk]')
    page.wait_for_timeout(800)
    msg = page.inner_text('#whd-msg')
    check('quedaste como acompañante de Mauricio Falcon' in msg, 'confirmación invertida (%s)' % msg)
    crew = recs(page, 'crew')[0]
    m = [x for x in crew['members'] if x['userId'] == 'b2A8']
    check(len(m) == 1 and m[0].get('viaClaim'), 'Conductor test quedó en la tripulación de Falcon')
    cl = [r for r in recs(page, 'claim') if r['userId'] == 'b43F'][0]
    check(cl['status'] == 'accepted' and cl.get('reversed'), 'declaración aceptada (invertida)')
    b.close()

if errors:
    print('\n'.join(errors))
    sys.exit(1)
print('TODO OK')
