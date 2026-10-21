'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Avatar } from './Avatar';
import { Button } from './Button';
import { Dialog, DialogClose } from './Dialog';
import { FormField } from './FormField';
import { Input } from './Input';
import {
  editedProfileName,
  prepareProfileImage,
  profileCrop,
  type ProfileImage,
} from '../profile-image';

export interface PersonalProfile {
  username: string;
  displayName: string | null;
  avatarRevision: string | null;
  lockVersion: string;
}
export type ProfileTranslate = (key: string) => string;
export function profileAvatarUrl(profile: PersonalProfile | null): string | undefined {
  return profile?.avatarRevision
    ? '/auth/profile/avatar?v=' + encodeURIComponent(profile.avatarRevision)
    : undefined;
}
function parseProfile(value: unknown): PersonalProfile | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as PersonalProfile;
  if (
    typeof p.username !== 'string' ||
    (p.displayName !== null && typeof p.displayName !== 'string') ||
    (p.avatarRevision !== null &&
      (typeof p.avatarRevision !== 'string' || !/^[a-f0-9]{64}$/.test(p.avatarRevision))) ||
    typeof p.lockVersion !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(p.lockVersion)
  )
    return null;
  return {
    username: p.username,
    displayName: p.displayName,
    avatarRevision: p.avatarRevision,
    lockVersion: p.lockVersion,
  };
}
async function getProfile(signal?: AbortSignal): Promise<PersonalProfile> {
  const response = await fetch('/auth/profile', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('loadFailed');
  const profile = parseProfile((await response.json()).data);
  if (!profile) throw new Error('loadFailed');
  return profile;
}

/** Lives in the persistent app shell; only the open action belongs in the menu. */
export function usePersonalProfile({ refreshKey, t }: { refreshKey: string; t: ProfileTranslate }) {
  const [profile, setProfile] = useState<PersonalProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const latest = useRef<PersonalProfile | null>(null);
  const epoch = useRef(0);
  const pending = useRef<Promise<PersonalProfile | null> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const apply = useCallback((next: PersonalProfile) => {
    if (latest.current && BigInt(next.lockVersion) < BigInt(latest.current.lockVersion)) return;
    latest.current = next;
    setProfile(next);
    setLoadError(false);
  }, []);
  const refresh = useCallback((): Promise<PersonalProfile | null> => {
    if (mutating.current) return Promise.resolve(null);
    if (pending.current) return pending.current;
    const revision = ++epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 20_000);
    const task = getProfile(abort.signal)
      .then((next) => {
        if (epoch.current === revision) apply(next);
        return next;
      })
      .catch(() => {
        if (epoch.current === revision) setLoadError(true);
        return null;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (epoch.current === revision) pending.current = null;
      });
    pending.current = task;
    return task;
  }, [apply]);
  useEffect(() => {
    void refresh();
    const foreground = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      ++epoch.current;
      controller.current?.abort();
      pending.current = null;
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [refresh, refreshKey]);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(false), 5000);
    return () => clearTimeout(timer);
  }, [status]);
  const mutation = useCallback((active: boolean) => {
    mutating.current = active;
    if (active) {
      ++epoch.current;
      controller.current?.abort();
      pending.current = null;
    }
  }, []);
  return {
    profile,
    avatarSrc: profileAvatarUrl(profile),
    triggerRef,
    openEditor: () => {
      setStatus(false);
      setOpen(true);
      void refresh();
    },
    editor: (
      <>
        {open ? (
          <PersonalProfileEditor
            latest={profile}
            loadError={loadError}
            onReload={refresh}
            onProfile={apply}
            onMutation={mutation}
            onClose={() => setOpen(false)}
            onSaved={() => {
              setStatus(true);
              setOpen(false);
            }}
            returnFocusTarget={triggerRef}
            t={t}
          />
        ) : null}
        {status ? (
          <div className="rx-profile-success" role="status">
            {t('profile.saved')}
          </div>
        ) : null}
      </>
    ),
  };
}

const ERROR_KEYS: Record<string, string> = {
  display_name_invalid: 'nameInvalid',
  avatar_size_exceeded: 'imageSize',
  avatar_dimensions_invalid: 'imageDimensions',
  avatar_animation_not_allowed: 'imageAnimation',
  avatar_content_type_invalid: 'imageType',
  avatar_media_type_mismatch: 'imageType',
  avatar_encoding_invalid: 'imageDecode',
  avatar_decode_failed: 'imageDecode',
  avatar_truncated: 'imageDecode',
  avatar_crop_invalid: 'cropInvalid',
  session_expired: 'sessionExpired',
};

export function PersonalProfileEditor({
  latest,
  loadError,
  onReload,
  onProfile,
  onMutation,
  onClose,
  onSaved,
  returnFocusTarget,
  t,
}: {
  latest: PersonalProfile | null;
  loadError: boolean;
  onReload: () => Promise<PersonalProfile | null>;
  onProfile: (profile: PersonalProfile) => void;
  onMutation: (active: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
  returnFocusTarget: RefObject<HTMLElement | null>;
  t: ProfileTranslate;
}) {
  const [base, setBase] = useState(latest);
  const [name, setName] = useState(latest?.displayName ?? '');
  const [action, setAction] = useState<'keep' | 'replace' | 'default'>('keep');
  const [image, setImage] = useState<ProfileImage | null>(null);
  const [zoom, setZoom] = useState(1);
  const [horizontal, setHorizontal] = useState(50);
  const [vertical, setVertical] = useState(50);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState(false);
  const [conflict, setConflict] = useState<PersonalProfile | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const busy = useRef(false);
  const reconciliation = useRef<AbortController | null>(null);
  const reconciliationGeneration = useRef(0);
  const nameChanged = base !== null && name !== (base.displayName ?? '');
  const dirty = nameChanged || action !== 'keep';
  const crop = image ? profileCrop(image.width, image.height, zoom, horizontal, vertical) : null;

  useEffect(() => {
    if (
      !dirty &&
      !conflict &&
      !reviewPending &&
      !saving &&
      latest &&
      (!base || BigInt(latest.lockVersion) >= BigInt(base.lockVersion))
    ) {
      setBase(latest);
      setName(latest.displayName ?? '');
    }
  }, [latest, base, dirty, conflict, reviewPending, saving]);
  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url);
    },
    [image],
  );
  useEffect(
    () => () => {
      ++sequence.current;
      ++reconciliationGeneration.current;
      reconciliation.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function choose(file: File | undefined) {
    if (!file || busy.current) return;
    const selected = ++sequence.current;
    setPreparing(true);
    setError(null);
    try {
      const prepared = await prepareProfileImage(file);
      if (selected !== sequence.current) {
        URL.revokeObjectURL(prepared.url);
        return;
      }
      setImage(prepared);
      setAction('replace');
      setZoom(1);
      setHorizontal(50);
      setVertical(50);
    } catch (failure) {
      if (selected === sequence.current)
        setError(
          failure instanceof Error &&
            ['imageSize', 'imageType', 'imageDimensions', 'imageAnimation', 'imageDecode'].includes(
              failure.message,
            )
            ? failure.message
            : 'imageDecode',
        );
    } finally {
      if (selected === sequence.current) setPreparing(false);
    }
  }
  function invalidateReconciliation() {
    ++reconciliationGeneration.current;
    reconciliation.current?.abort();
    reconciliation.current = null;
    setReconciling(false);
  }
  async function reconcile() {
    if (reconciliation.current) return;
    const controller = new AbortController();
    const generation = ++reconciliationGeneration.current;
    reconciliation.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    setReconciling(true);
    setReviewPending(true);
    setUncertain(true);
    setError('saveUncertain');
    try {
      const current = await getProfile(controller.signal);
      if (generation !== reconciliationGeneration.current) return;
      onProfile(current);
      setConflict(current);
    } catch {
      if (generation === reconciliationGeneration.current) setError('reconcileFailed');
    } finally {
      clearTimeout(timeout);
      if (generation === reconciliationGeneration.current) {
        reconciliation.current = null;
        setReconciling(false);
      }
    }
  }
  async function save() {
    if (!base || busy.current || preparing || conflict || reviewPending) return;
    const editedName = nameChanged ? editedProfileName(name) : null;
    if (nameChanged && editedName === null) {
      setNameError(true);
      nameRef.current?.focus();
      return;
    }
    if (!dirty) {
      onClose();
      return;
    }
    invalidateReconciliation();
    busy.current = true;
    setSaving(true);
    onMutation(true);
    setError(null);
    const data = new FormData();
    data.set('expectedLockVersion', base.lockVersion);
    data.set('avatarAction', action);
    if (nameChanged && editedName !== null) data.set('displayName', editedName);
    if (action === 'replace' && image && crop) {
      data.set('image', image.file);
      data.set('crop', JSON.stringify(crop));
    }
    try {
      const response = await fetch('/auth/profile', {
        method: 'PUT',
        body: data,
        signal: AbortSignal.timeout(50_000),
      });
      const result = await response.json();
      const current = parseProfile(result.data);
      if (response.ok && current) {
        onProfile(current);
        onSaved();
        return;
      }
      if (response.status === 409 && current) {
        onProfile(current);
        setConflict(current);
        setError('conflict');
        return;
      }
      // A received, structured error is a definite rejection. Only an explicit
      // uncertain result needs reconciliation; treating every 5xx as uncertain
      // made known avatar storage failures show the wrong recovery state.
      if (result.error === 'profile_save_uncertain') {
        await reconcile();
        return;
      }
      const key = ERROR_KEYS[result.error] ?? 'saveFailed';
      if (key === 'nameInvalid') {
        setNameError(true);
        nameRef.current?.focus();
      } else setError(key);
    } catch {
      await reconcile();
    } finally {
      busy.current = false;
      setSaving(false);
      onMutation(false);
    }
  }
  function rebase() {
    if (!conflict) return;
    invalidateReconciliation();
    // Only preserve fields the user actually changed against the original baseline.
    if (!nameChanged) setName(conflict.displayName ?? '');
    setBase(conflict);
    setConflict(null);
    setReviewPending(false);
    setUncertain(false);
    setError(null);
  }
  const previewName = name || base?.username || '';
  const photoStyle =
    image && crop
      ? {
          width: (image.width / crop.width) * 100 + '%',
          maxWidth: 'none',
          left: (-crop.x / crop.width) * 100 + '%',
          top: (-crop.y / crop.height) * 100 + '%',
        }
      : undefined;
  return (
    <Dialog
      open
      title={t('profile.edit')}
      description={t('profile.description')}
      size="sm"
      surface="warm"
      closeLabel={t('profile.close')}
      dismissOnOverlay={false}
      dismissible={!saving && !preparing}
      dirty={dirty}
      discardConfirm={{
        title: t('profile.discardTitle'),
        description: t('profile.discardDescription'),
        cancelLabel: t('profile.keepEditing'),
        confirmLabel: t('profile.discard'),
      }}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      initialFocus={nameRef}
      returnFocusTarget={returnFocusTarget}
      footer={
        <>
          <DialogClose>
            <Button variant="default" disabled={saving || preparing}>
              {t('profile.cancel')}
            </Button>
          </DialogClose>
          <Button
            onClick={() => void save()}
            loading={saving}
            loadingLabel={t('profile.saving')}
            disabled={!base || preparing || Boolean(conflict) || reviewPending}
          >
            {t('profile.save')}
          </Button>
        </>
      }
    >
      {!base ? (
        <div role={loadError ? 'alert' : 'status'}>
          {t(loadError ? 'profile.loadFailed' : 'profile.loading')}
          {loadError ? (
            <Button variant="link" onClick={() => void onReload()}>
              {t('profile.retry')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="rx-profile-form">
          {error ? (
            <p className="rx-profile-error" role="alert">
              {t('profile.' + error)}
            </p>
          ) : null}
          {reviewPending && !conflict ? (
            <Button
              variant="outline"
              disabled={saving}
              loading={reconciling}
              loadingLabel={t('profile.loading')}
              onClick={() => void reconcile()}
            >
              {t('profile.checkLatest')}
            </Button>
          ) : null}
          {conflict ? (
            <section className="rx-profile-conflict" aria-label={t('profile.latest')}>
              <strong>{t('profile.latest')}</strong>
              <div className="rx-profile-avatar-row">
                <Avatar
                  name={conflict.displayName || conflict.username}
                  src={profileAvatarUrl(conflict)}
                />
                <span>{conflict.displayName || conflict.username}</span>
              </div>
              <p>{t(uncertain ? 'profile.uncertainReview' : 'profile.conflictReview')}</p>
              <Button variant="outline" disabled={saving} onClick={rebase}>
                {t('profile.reviewed')}
              </Button>
            </section>
          ) : null}
          <FormField label={t('profile.username')} help={t('profile.usernameHint')}>
            <Input readOnly value={base.username} />
          </FormField>
          <FormField
            label={t('profile.name')}
            help={t('profile.nameHint')}
            error={nameError ? t('profile.nameInvalid') : undefined}
          >
            <Input
              ref={nameRef}
              value={name}
              disabled={saving}
              onBlur={() => {
                if (nameChanged) setNameError(editedProfileName(name) === null);
              }}
              onValueChange={(value) => {
                setName(value);
                if (nameError) setNameError(editedProfileName(value) === null);
              }}
            />
          </FormField>
          <div className="rx-profile-avatar-row">
            <div className="rx-profile-preview" role="img" aria-label={t('profile.preview')}>
              {image && action === 'replace' ? (
                <img alt="" src={image.url} style={photoStyle} />
              ) : (
                <Avatar
                  decorative
                  name={previewName}
                  src={action === 'default' ? undefined : profileAvatarUrl(base)}
                />
              )}
            </div>
            <div className="rx-profile-avatar-actions">
              <Button
                variant="outline"
                loading={preparing}
                loadingLabel={t('profile.preparing')}
                disabled={saving}
                onClick={() => inputRef.current?.click()}
              >
                {t('profile.chooseImage')}
              </Button>
              <Button
                variant="link"
                disabled={
                  saving ||
                  preparing ||
                  (action === 'keep' && !base.avatarRevision) ||
                  action === 'default'
                }
                onClick={() => {
                  ++sequence.current;
                  setImage(null);
                  setAction(base.avatarRevision ? 'default' : 'keep');
                  setError(null);
                }}
              >
                {t('profile.restoreDefault')}
              </Button>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              aria-label={t('profile.chooseImage')}
              onChange={(event) => {
                void choose(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
          </div>
          <p className="rx-profile-hint">{t('profile.imageHint')}</p>
          {image && action === 'replace' ? (
            <fieldset className="rx-profile-crop" disabled={saving || preparing}>
              <legend>{t('profile.crop')}</legend>
              <div
                className="rx-profile-crop-frame"
                role="img"
                aria-label={t('profile.cropPreview')}
              >
                <img alt="" src={image.url} style={photoStyle} />
              </div>
              <p className="rx-profile-hint">{t('profile.cropHint')}</p>
              <label>
                {t('profile.zoom')}
                <input
                  type="range"
                  min="1"
                  max="4"
                  step="0.01"
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                />
              </label>
              <label>
                {t('profile.horizontal')}
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={horizontal}
                  onChange={(event) => setHorizontal(Number(event.target.value))}
                />
              </label>
              <label>
                {t('profile.vertical')}
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={vertical}
                  onChange={(event) => setVertical(Number(event.target.value))}
                />
              </label>
            </fieldset>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
