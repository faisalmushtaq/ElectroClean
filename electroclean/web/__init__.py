"""ElectroClean on the web: the study server for the browser version.

The browser application (``electroclean/web/static/``) reads each recording from the
annotator's own computer; the EEG never reaches the server. The server (this package) holds
the study: its settings, accounts and assignments, the register of recordings (one
*manifest* per recording, made by the administrator from the real files), drafts, the
training references (which never leave it) and the results, written with ElectroClean's own
code in its results layout. See docs/web/architecture.md, docs/web/api.md and
docs/web/server.md.

MNE-Python is used only when recordings are registered (:mod:`electroclean.web.manifest`).
"""

API_PREFIX = "/api/v1"
