#!/usr/bin/env python3
"""Regenera la web pública (public/index.html y public/img/) a partir de web/src/ y web/img/.

Uso, desde la raíz del repositorio:  python3 web/build.py
Los textos de cada idioma están en web/src/content/; los datos del despacho (teléfono, dirección, horario), al principio de web/src/app.js.
"""
import pathlib, shutil
here = pathlib.Path(__file__).parent
src, out = here / 'src', here.parent / 'public'
langs = [p for p in ['es', 'va', 'it', 'ru', 'hy'] if (src / 'content' / f'{p}.js').exists()]
js = '\n'.join((src / f).read_text(encoding='utf-8') for f in ['icons.js'] + [f'content/{l}.js' for l in langs] + ['app.js'])
css = (src / 'styles.css').read_text(encoding='utf-8')
tpl = (src / 'index.template.html').read_text(encoding='utf-8')
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500'
         '&family=EB+Garamond:ital,wght@0,400;0,500;1,400&family=Noto+Serif+Armenian:wght@400;500;600&display=swap">')
API = '<script>window.IA_CONFIG = { api: "/api" };</script>\n'
html = tpl.replace('{{FONTS}}', FONTS).replace('{{CSS}}', css).replace('{{CONFIG}}', API).replace('{{JS}}', js)
out.mkdir(parents=True, exist_ok=True)
(out / 'index.html').write_text(html, encoding='utf-8')
(out / 'img').mkdir(exist_ok=True)
for f in (here / 'img').glob('*.jpg'):
    shutil.copy2(f, out / 'img' / f.name)
print('ok', langs, round(len(html) / 1024), 'KB')
