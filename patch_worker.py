import re

with open("worker.js", "r") as f:
    content = f.read()

old_opts = """      const opts = {
        locateFile: (p) => new URL(p, src.js).href,
        mainScriptUrlOrBlob: src.js,
      };"""

new_opts = """      const opts = {
        locateFile: (p) => { let url = new URL(src.js, location.href).href; return url.replace(/[^\\/]+$/, p); },
        mainScriptUrlOrBlob: new URL(src.js, location.href).href,
      };"""

content = content.replace(old_opts, new_opts)

with open("worker.js", "w") as f:
    f.write(content)
