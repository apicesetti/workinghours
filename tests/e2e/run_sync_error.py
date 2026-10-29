"""El aviso de sincronización muestra el error del servidor y 'Reintentar' lo resuelve."""
import pathlib, sys
from playwright.sync_api import sync_playwright
import datetime

AR = datetime.timezone(datetime.timedelta(hours=-3))
FIXED_NOW = datetime.datetime.now(AR).replace(hour=18, minute=30, second=0, microsecond=0)

REPO = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).parent
(HERE / 'shots').mkdir(exist_ok=True)
errors = []

def check(cond, msg):
    print(('OK   ' if cond else 'FAIL ') + msg)
    if not cond:
        errors.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 400, 'height': 820}, timezone_id='America/Argentina/Buenos_Aires').new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    page.clock.set_fixed_time(FIXED_NOW)
    page.add_init_script(path=str(HERE / 'mockapi.js'))
    page.goto((REPO / 'workingHoursDrive.html').as_uri())
    # el servidor rechaza escrituras en AddInData como lo haría MyGeotab sin permiso
    page.evaluate("""() => {
        const orig = window.__api.call;
        window.__api.call = (m, p, ok, err) => {
            if (window.__denyWrites && (m === 'Add' || m === 'Set') && p.typeName === 'AddInData') {
                setTimeout(() => err({ name: 'JSONRPCError', message: 'Request failed',
                    errors: [{ name: 'MissingMethodException', message: 'Add is not supported for current security clearance' }] }), 5);
                return;
            }
            orig(m, p, ok, err);
        };
        window.__denyWrites = true;
    }""")
    page.evaluate("""() => new Promise(res => {
        const o = geotab.addin.workingHoursDrive();
        o.initialize(window.__api, window.__state, () => { o.focus(window.__api, window.__state); res(); });
    })""")
    page.wait_for_selector('.whd-card')
    page.click('[data-act=crew]')
    page.check('[data-pick=b66]')
    page.click('[data-act=saveCrew]')
    page.wait_for_timeout(500)
    sync = page.inner_text('#whd-sync')
    print('      aviso:', sync.replace('\n', ' | '))
    check('1 cambio sin sincronizar' in sync, 'queda pendiente')
    check('MissingMethodException' in sync and 'security clearance' in sync, 'el aviso muestra el motivo del servidor')
    check(page.locator('#whd-sync [data-act=retry]').count() == 1, 'botón Reintentar visible')
    page.screenshot(path=str(HERE / 'shots' / 'drive_sync_error.png'))
    page.evaluate('window.__denyWrites = false')
    page.click('#whd-sync [data-act=retry]')
    page.wait_for_timeout(500)
    check(page.is_hidden('#whd-sync'), 'después de reintentar ya no hay pendientes')
    check(len(page.evaluate('window.__db.AddInData')) == 1, 'el registro llegó al servidor')
    b.close()

print()
print('ERRORES:' if errors else 'TODO OK', *errors, sep='\n  ')
sys.exit(1 if errors else 0)
