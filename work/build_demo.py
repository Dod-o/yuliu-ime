from pathlib import Path
root=Path(__file__).resolve().parent.parent
(root/'lime/interface/dist').mkdir(parents=True,exist_ok=True)
html=(root/'work/try-template.html').read_text(encoding='utf-8')
html=html.replace('__LOCAL_KEY__',(root/'work/local-key.txt').read_text().strip())
(root/'lime/interface/dist/try.html').write_text(html,encoding='utf-8')
