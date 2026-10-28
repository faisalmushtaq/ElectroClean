"""ElectroClean on Firebase: the administrator's access (Admin SDK) and the Cloud Functions.

Real studies run on Firebase (docs/web/firebase.md): annotators sign in with Firebase
Authentication, the study's records are in Firestore and the private work is done by the Python
Cloud Functions in ``functions/`` (``main.py``), which call :class:`electroclean.web.service.StudyService`
with a :class:`electroclean.web.store_firestore.FirestoreStore`.

The administrator's command (``electroclean-web ... --firebase-project P --study S``) uses the
Admin SDK with the service account in ``GOOGLE_APPLICATION_CREDENTIALS``. With the Firebase
Emulator Suite (``FIRESTORE_EMULATOR_HOST`` and ``FIREBASE_AUTH_EMULATOR_HOST`` set) no credentials
are needed.
"""

from __future__ import annotations

import os
from typing import Any

#: The region of the functions and the Firestore database (London).
REGION = "europe-west2"
_APPS: dict[str, Any] = {}


def firebase_app(project: str) -> Any:
    """The Admin SDK app for a project (credentials from GOOGLE_APPLICATION_CREDENTIALS, or the emulators)."""
    import firebase_admin

    if project in _APPS:
        return _APPS[project]
    name = f"electroclean-{project}"
    try:
        app = firebase_admin.get_app(name)
    except ValueError:
        cred = None
        if os.environ.get("FIREBASE_AUTH_EMULATOR_HOST") or os.environ.get("FIRESTORE_EMULATOR_HOST"):
            from firebase_admin import credentials

            from google.auth.credentials import AnonymousCredentials

            class _Emulator(credentials.Base):
                def get_credential(self) -> Any:  # noqa: D102 - the emulators accept any credentials
                    return AnonymousCredentials()

            cred = _Emulator()
        app = firebase_admin.initialize_app(cred, {"projectId": project}, name=name)
    _APPS[project] = app
    return app


def firestore_client(project: str) -> Any:
    """A Firestore client for the project (the emulator's when FIRESTORE_EMULATOR_HOST is set)."""
    if os.environ.get("FIRESTORE_EMULATOR_HOST"):
        from google.auth.credentials import AnonymousCredentials
        from google.cloud import firestore

        return firestore.Client(project=project, credentials=AnonymousCredentials())
    from firebase_admin import firestore

    return firestore.client(firebase_app(project))


def claims_for(existing: dict[str, Any] | None, annotator_id: str, study: str, role: str) -> dict[str, Any]:
    """Custom claims giving a Firebase user an annotator ID and a role in a study (other studies kept)."""
    claims = dict(existing or {})
    if claims.get("annotator_id") and claims["annotator_id"] != annotator_id:
        raise ValueError(f"This Firebase user is already annotator {claims['annotator_id']}; an annotator keeps one "
                         "ID in every study of a project")
    roles = dict(claims.get("roles") or {})
    roles[study] = role
    return {"annotator_id": annotator_id, "role": role, "roles": roles, "studies": sorted(roles)}


def role_in(claims: dict[str, Any], study: str) -> str | None:
    """The role the claims give in a study, or None if they give none."""
    roles = claims.get("roles")
    if isinstance(roles, dict):
        r = roles.get(study)
        return str(r) if r else None
    studies = claims.get("studies")
    if isinstance(studies, list) and study not in studies:
        return None
    return str(claims.get("role") or "annotator") if claims.get("annotator_id") else None
