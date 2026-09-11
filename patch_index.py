import re

with open("index.html", "r") as f:
    content = f.read()

# Fix CSP
content = content.replace("[cdn.jsdelivr.net](https://cdn.jsdelivr.net)", "https://cdn.jsdelivr.net")
content = content.replace("[0.peerjs.com](https://0.peerjs.com)", "https://0.peerjs.com")

# Fix links and scripts
content = re.sub(r'\[cdn\.jsdelivr\.net\]\((https://cdn\.jsdelivr\.net/npm/.*?)\)', r'\1', content)

with open("index.html", "w") as f:
    f.write(content)
