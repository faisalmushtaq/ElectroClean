"""ElectroTag on Firebase: the administrator's access (Admin SDK) and the Cloud Functions.

Real studies run on Firebase (docs/web/firebase.md): annotators sign in with Firebase
Authentication, the study's records are in Firestore and the private work is done by the Python
Cloud Functions in ``functions/`` (``main.py``), which call :class:`electrotag.web.service.StudyService`
with a :class:`electrotag.web.store_firestore.FirestoreStore`.

The administrator's command (``electrotag-web ... --firebase-project P --study S``) uses the
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
    name = f"electrotag-{project}"
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


def _study_roles(value: Any) -> tuple[str, ...]:
    """The roles a claim gives in one study: the list written now, or the single role of older claims."""
    from electrotag.web.store import parse_roles

    return parse_roles(value if isinstance(value, (str, list, tuple)) else None, fallback="")


def claims_for(existing: dict[str, Any] | None, annotator_id: str, study: str,
               roles: str | list[str] | tuple[str, ...]) -> dict[str, Any]:
    """Custom claims giving a Firebase user an annotator ID and roles in a study (other studies kept):
    ``roles[study]`` is the list of roles and ``role`` the primary role (of the study just set)."""
    from electrotag.web.store import primary_role

    claims = dict(existing or {})
    if claims.get("annotator_id") and claims["annotator_id"] != annotator_id:
        raise ValueError(f"This Firebase user is already annotator {claims['annotator_id']}; an annotator keeps one "
                         "ID in every study of a project")
    mine = _study_roles(roles) or ("annotator",)
    by_study = dict(claims.get("roles") or {})
    by_study[study] = list(mine)
    return {"annotator_id": annotator_id, "role": primary_role(mine), "roles": by_study, "studies": sorted(by_study)}


def claims_without(existing: dict[str, Any] | None, study: str) -> dict[str, Any]:
    """The claims with one study taken out (the annotator ID stays while other studies remain)."""
    from electrotag.web.store import primary_role

    claims = dict(existing or {})
    roles = {k: v for k, v in dict(claims.get("roles") or {}).items() if k != study}
    if not roles:
        return {}
    first = sorted(roles)[0]
    return {**claims, "roles": roles, "studies": sorted(roles), "role": primary_role(_study_roles(roles[first]))}


class AuthProblem(ValueError):
    """Firebase Authentication refused (``code`` names why: email_in_use, invalid_email, weak_password)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


def ensure_auth_user(app: Any, *, email: str, annotator_id: str, study: str, role: str, display_name: str = "",
                     password: str | None = None, update_existing: bool = True,
                     roles: tuple[str, ...] | list[str] | None = None) -> tuple[str, str | None]:
    """The Firebase user with this email address (created if needed) with the claims of the study.

    Returns its uid and, when no password was given, a link with which the person chooses one.
    ``update_existing`` sets the given password and name on a user who already exists."""
    from firebase_admin import auth

    try:
        try:
            user = auth.get_user_by_email(email, app=app)
            if update_existing and (password or display_name):
                auth.update_user(user.uid, password=password or None, display_name=display_name or None, app=app)
        except auth.UserNotFoundError:
            user = auth.create_user(email=email, password=password or None, display_name=display_name or None,
                                    app=app)
        try:
            claims = claims_for(user.custom_claims, annotator_id, study, roles or role)
        except ValueError as exc:
            raise AuthProblem("email_in_use", f"{email} already signs in as another annotator ID: {exc}") from exc
        auth.set_custom_user_claims(user.uid, claims, app=app)
        link = None if password else auth.generate_password_reset_link(email, app=app)
    except auth.EmailAlreadyExistsError as exc:
        raise AuthProblem("email_in_use", f"{email} already has a Firebase account") from exc
    except ValueError as exc:
        if isinstance(exc, AuthProblem):
            raise
        raise AuthProblem("invalid_account", f"Firebase refused the account: {exc}") from exc
    return user.uid, link


def password_link(app: Any, email: str) -> str:
    """A link that lets the person choose a new password (it works once)."""
    from firebase_admin import auth

    return auth.generate_password_reset_link(email, app=app)


def set_roles(app: Any, uid: str, annotator_id: str, study: str, roles: str | list[str] | tuple[str, ...]) -> None:
    """Write a person's roles in a study into their claims (other studies kept)."""
    from firebase_admin import auth

    user = auth.get_user(uid, app=app)
    auth.set_custom_user_claims(uid, claims_for(user.custom_claims, annotator_id, study, roles), app=app)


set_role = set_roles  # the name of the time when a person had one role


def set_disabled(app: Any, uid: str, disabled: bool) -> None:
    """Disabling stops sign-in and ends the sessions the person has (their refresh tokens are revoked)."""
    from firebase_admin import auth

    auth.update_user(uid, disabled=disabled, app=app)
    if disabled:
        auth.revoke_refresh_tokens(uid, app=app)


def leave_study(app: Any, uid: str, study: str) -> None:
    """Take the study out of the user's claims; a user who takes part in no other study is deleted."""
    from firebase_admin import auth

    try:
        user = auth.get_user(uid, app=app)
    except auth.UserNotFoundError:
        return
    claims = claims_without(user.custom_claims, study)
    if not claims.get("roles"):
        auth.delete_user(uid, app=app)
        return
    auth.set_custom_user_claims(uid, claims, app=app)
    auth.revoke_refresh_tokens(uid, app=app)


def role_in(claims: dict[str, Any], study: str) -> tuple[str, ...] | None:
    """The roles the claims give in a study (the list written now, or the single role of older claims), or
    None if they give the person no place in it."""
    roles = claims.get("roles")
    if isinstance(roles, dict):
        r = roles.get(study)
        return (_study_roles(r) or ("annotator",)) if r else None
    studies = claims.get("studies")
    if isinstance(studies, list) and study not in studies:
        return None
    return _study_roles(claims.get("role") or "annotator") or ("annotator",) if claims.get("annotator_id") else None
