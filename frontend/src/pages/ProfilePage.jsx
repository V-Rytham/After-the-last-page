import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, LoaderCircle, PencilLine, X } from 'lucide-react';
import api from '../utils/api';
import { getStoredUser } from '../utils/auth';
import GenreSelector from '../components/profile/GenreSelector';
import { readSelectedGenres, writeSelectedGenres } from '../utils/genrePreferences';
import useRecommendations from '../hooks/useRecommendations';
import './ProfilePage.css';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMPTY_STATS = { booksCompleted: 0, discussionsParticipated: 0 };

const normalizeUsername = (value) => String(value || '').trim();
const normalizeGenre = (value) => String(value || '').trim().toLowerCase();

const formatJoinedDate = (value) => {
  if (!value) {
    return '—';
  }

  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(value));
  } catch {
    return '—';
  }
};

const getUsernameValidationMessage = (username) => {
  const normalized = normalizeUsername(username);

  if (!normalized) {
    return 'Username is required.';
  }

  if (!USERNAME_RE.test(normalized)) {
    return 'Use 3-20 letters, numbers, or underscores.';
  }

  return '';
};

const ProfilePage = ({ currentUser, onUserUpdate }) => {
  const storedUser = useMemo(() => getStoredUser(), []);
  const baseUser = useMemo(() => {
    if (currentUser && !currentUser.isAnonymous) {
      return currentUser;
    }
    return storedUser;
  }, [currentUser, storedUser]);

  const [profile, setProfile] = useState(() => ({
    ...(baseUser || {}),
    stats: baseUser?.stats || EMPTY_STATS,
  }));
  const [editForm, setEditForm] = useState({
    name: baseUser?.name || '',
    username: baseUser?.username || '',
    bio: baseUser?.bio || '',
  });
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [usernameState, setUsernameState] = useState({ status: 'idle', message: '' });
  const [imageFailed, setImageFailed] = useState(false);
  const [selectedGenres, setSelectedGenres] = useState(() => readSelectedGenres());
  const [savingGenres, setSavingGenres] = useState(false);

  useRecommendations(selectedGenres);

  const normalizedUsername = normalizeUsername(editForm.username);
  const currentNormalizedUsername = normalizeUsername(profile?.username);

  useEffect(() => {
    setProfile((prev) => ({
      ...(prev || {}),
      ...(baseUser || {}),
      stats: prev?.stats || baseUser?.stats || EMPTY_STATS,
    }));

    setEditForm((prev) => ({
      ...prev,
      name: baseUser?.name || '',
      username: baseUser?.username || '',
      bio: baseUser?.bio || '',
    }));
  }, [baseUser]);

  useEffect(() => {
    let cancelled = false;

    const fetchProfile = async () => {
      setLoading(true);

      try {
        const { data } = await api.get('/users/profile');
        if (cancelled) {
          return;
        }

        setProfile({ ...data, stats: data.stats || EMPTY_STATS });
        setEditForm({
          name: data.name || '',
          username: data.username || '',
          bio: data.bio || '',
        });
        const profileGenres = Array.isArray(data.preferredGenres) ? data.preferredGenres : [];
        const normalized = Array.from(new Set(profileGenres.map(normalizeGenre).filter(Boolean)));
        setSelectedGenres(normalized);
        writeSelectedGenres(normalized);
        onUserUpdate?.(data);
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError.response?.data?.message || 'Could not load your profile right now.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchProfile();

    return () => {
      cancelled = true;
    };
  }, [onUserUpdate]);

  useEffect(() => {
    if (!editing) {
      setUsernameState({ status: 'idle', message: '' });
      return undefined;
    }

    const usernameMessage = getUsernameValidationMessage(editForm.username);
    if (usernameMessage) {
      setUsernameState({ status: 'invalid', message: usernameMessage });
      return undefined;
    }

    if (normalizedUsername.toLowerCase() === currentNormalizedUsername.toLowerCase()) {
      setUsernameState({ status: 'unchanged', message: 'This is your current username.' });
      return undefined;
    }

    setUsernameState({ status: 'checking', message: 'Checking username…' });

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      try {
        const { data } = await api.get('/users/username-availability', {
          params: { username: normalizedUsername },
        });

        if (!cancelled) {
          setUsernameState({
            status: data.available ? 'available' : 'taken',
            message: data.message,
          });
        }
      } catch (requestError) {
        if (cancelled) {
          return;
        }

        setUsernameState({
          status: 'invalid',
          message: requestError.response?.data?.message || 'Could not validate that username right now.',
        });
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [currentNormalizedUsername, editForm.username, editing, normalizedUsername]);

  const displayName = profile?.name || profile?.email || 'Reader';
  const email = profile?.email || '—';
  const username = profile?.username || '—';
  const bio = String(profile?.bio || '').trim();
  const joinedDate = formatJoinedDate(profile?.joinedAt);
  const stats = profile?.stats || EMPTY_STATS;
  const profileImageUrl = profile?.profileImageUrl || '';

  useEffect(() => {
    setImageFailed(false);
  }, [profileImageUrl]);

  const handleEditChange = (event) => {
    const { name, value } = event.target;
    setEditForm((prev) => ({ ...prev, [name]: value }));
    setError('');
    setSuccess('');
  };

  useEffect(() => {
    writeSelectedGenres(selectedGenres);
    if (selectedGenres.length === 0) return;

    setSavingGenres(true);
    api.put('/users/preferences/genres', { preferredGenres: selectedGenres })
      .then(({ data }) => {
        if (data) {
          setProfile((prev) => ({ ...(prev || {}), ...data, stats: data.stats || prev?.stats || EMPTY_STATS }));
          onUserUpdate?.(data);
        }
      })
      .catch((requestError) => {
        console.warn('[PROFILE] Failed to persist genres:', requestError?.uiMessage || requestError?.message || requestError);
      })
      .finally(() => setSavingGenres(false));
  }, [onUserUpdate, selectedGenres]);

  const handleStartEditing = () => {
    setEditForm({
      name: profile?.name || '',
      username: profile?.username || '',
      bio: profile?.bio || '',
    });
    setEditing(true);
    setError('');
    setSuccess('');
  };

  const handleCancelEditing = () => {
    setEditForm({
      name: profile?.name || '',
      username: profile?.username || '',
      bio: profile?.bio || '',
    });
    setEditing(false);
    setError('');
    setSuccess('');
    setUsernameState({ status: 'idle', message: '' });
  };

  const handleSave = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');

    const trimmedName = String(editForm.name || '').trim();
    const usernameMessage = getUsernameValidationMessage(editForm.username);

    if (!trimmedName) {
      setError('Name is required.');
      return;
    }

    if (usernameMessage) {
      setError(usernameMessage);
      return;
    }

    if (editForm.bio.trim().length > 160) {
      setError('Bio must be 160 characters or fewer.');
      return;
    }

    if (usernameState.status === 'taken') {
      setError('Choose a different username before saving.');
      return;
    }

    setSaving(true);

    try {
      const payload = {
        name: trimmedName,
        username: normalizedUsername,
        bio: editForm.bio,
      };
      const { data } = await api.put('/users/profile', payload);
      setProfile({ ...data, stats: data.stats || EMPTY_STATS });
      onUserUpdate?.(data);
      setEditing(false);
      setSuccess('Profile updated.');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not save your profile right now.');
    } finally {
      setSaving(false);
    }
  };

  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read this image file.'));
    reader.readAsDataURL(file);
  });

  const handleProfileImageChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError('');
    setSuccess('');
    setUploadingImage(true);

    try {
      const profileImageData = await fileToDataUrl(file);
      const { data } = await api.put('/users/profile/image', { profileImageData });
      setProfile({ ...data, stats: data.stats || EMPTY_STATS });
      onUserUpdate?.(data);
      setSuccess('Profile image updated.');
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message || 'Could not upload profile image right now.');
    } finally {
      setUploadingImage(false);
      event.target.value = '';
    }
  };

  const handleRemoveProfileImage = async () => {
    setError('');
    setSuccess('');
    setUploadingImage(true);

    try {
      const { data } = await api.delete('/users/profile/image');
      setProfile({ ...data, stats: data.stats || EMPTY_STATS });
      onUserUpdate?.(data);
      setSuccess('Profile image removed.');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not remove profile image right now.');
    } finally {
      setUploadingImage(false);
    }
  };

  return (
    <div className="profile-page animate-fade-in">
      <header className="profile-head">
        <div>
          <h1 className="font-serif">Profile</h1>
        </div>

        {!editing ? (
          <button type="button" className="btn-secondary profile-edit-btn" onClick={handleStartEditing}>
            <PencilLine size={16} /> Edit profile
          </button>
        ) : null}
      </header>

      {(error || success) && (
        <div className={`profile-feedback ${error ? 'error' : 'success'}`} role="status">
          {error || success}
        </div>
      )}

      <section className="profile-hero glass-panel" aria-label="Public profile overview">
        <div className="profile-identity">
          <div className="profile-avatar-shell" aria-hidden="true">
            {profileImageUrl && !imageFailed ? (
              <img src={profileImageUrl} alt="" onError={() => setImageFailed(true)} loading="lazy" />
            ) : (
              <span>{displayName.charAt(0).toUpperCase()}</span>
            )}
          </div>

          <div className="profile-identity-copy">
            <h2 className="font-serif">{displayName}</h2>
            <div className="profile-meta-line">
              <span>{username}</span>
              <span aria-hidden="true">•</span>
              <span>Joined {joinedDate}</span>
              {bio ? <span className="profile-bio-inline">{bio}</span> : null}
            </div>
          </div>
        </div>

      </section>

      <section className="profile-grid">
        <div className="profile-column">
          <section className="profile-card glass-panel" aria-label="Account details">
            <div className="profile-card-head">
              <h2 className="font-serif">Account details</h2>
            </div>

            {!editing ? (
              <div className="profile-details-panel">
                <div className="profile-details-group" aria-label="Profile details">
                  <dl className="profile-details-grid">
                    <div className="profile-detail">
                      <dt>Name</dt>
                      <dd>{displayName}</dd>
                    </div>
                    <div className="profile-detail">
                      <dt>Username</dt>
                      <dd>{username}</dd>
                    </div>
                  </dl>
                </div>

                <div className="profile-details-group" aria-label="Contact">
                  <h3>Contact</h3>
                  <dl className="profile-details-grid">
                    <div className="profile-detail">
                      <dt>Email</dt>
                      <dd>{email}</dd>
                    </div>
                  </dl>
                </div>

                <div className="profile-details-group" aria-label="Joined info">
                  <dl className="profile-details-grid">
                    <div className="profile-detail">
                      <dt>Joined</dt>
                      <dd>{joinedDate}</dd>
                    </div>
                  </dl>
                </div>

                <div className="profile-details-group profile-details-group-bio" aria-label="Bio">
                  <h3>Bio</h3>
                  <p>{bio}</p>
                </div>
              </div>
            ) : (
              <form className="profile-form" onSubmit={handleSave}>
                <label className="profile-input-group">
                  <span>Name</span>
                  <input name="name" value={editForm.name} onChange={handleEditChange} className="profile-input" maxLength={80} required />
                </label>

                <label className="profile-input-group">
                  <span>Username</span>
                  <input name="username" value={editForm.username} onChange={handleEditChange} className="profile-input" minLength={3} maxLength={20} autoCapitalize="none" autoCorrect="off" required />
                </label>
                <div className={`profile-inline-note ${usernameState.status}`} aria-live="polite">
                  {usernameState.status === 'checking' && <LoaderCircle size={14} className="profile-note-icon profile-spin" />}
                  {usernameState.status === 'available' && <CheckCircle2 size={14} className="profile-note-icon" />}
                  <span>{usernameState.message || 'This username appears publicly on your profile and in reader spaces.'}</span>
                </div>

                <label className="profile-input-group">
                  <span>Bio <em>(optional)</em></span>
                  <textarea name="bio" value={editForm.bio} onChange={handleEditChange} className="profile-input profile-textarea" rows={4} maxLength={160} placeholder="Tell readers how you like to show up in discussion." />
                </label>
                <div className="profile-character-count">{editForm.bio.length}/160</div>

                <div className="profile-image-controls">
                  <label className="btn-secondary profile-image-upload-btn">
                    {uploadingImage ? 'Uploading image…' : 'Upload profile image'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={handleProfileImageChange}
                      disabled={uploadingImage || saving}
                    />
                  </label>
                  {profileImageUrl ? (
                    <button type="button" className="btn-secondary profile-image-remove-btn" onClick={handleRemoveProfileImage} disabled={uploadingImage || saving}>
                      Remove image
                    </button>
                  ) : null}
                </div>

                <div className="profile-form-actions">
                  <button type="submit" className="btn-primary" disabled={saving || uploadingImage || usernameState.status === 'checking'}>
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  <button type="button" className="btn-secondary" onClick={handleCancelEditing} disabled={saving || uploadingImage}>
                    <X size={16} /> Cancel
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>

        <aside className="profile-column profile-column-side">
          <section className="profile-card glass-panel" aria-label="Reading stats">
            <div className="profile-card-head">
              <h2 className="font-serif">Reading stats</h2>
            </div>

            <div className="profile-stats-grid">
              <article className="profile-stat-tile">
                <strong>{loading ? '…' : stats.booksCompleted}</strong>
                <span>Books completed</span>
              </article>
              <article className="profile-stat-tile">
                <strong>{loading ? '…' : stats.discussionsParticipated}</strong>
                <span>Discussions participated</span>
              </article>
            </div>
          </section>
          <section className="profile-card glass-panel" aria-label="Preferred genres">
            <div className="profile-card-head">
              <h2 className="font-serif">Preferred genres</h2>
            </div>
            <p className="profile-inline-note">Select a few genres and your library will be curated instantly.</p>
            <GenreSelector
              selectedGenres={selectedGenres}
              disabled={savingGenres}
              onChange={(next) => setSelectedGenres(Array.from(new Set(next.map(normalizeGenre).filter(Boolean))))}
            />
          </section>

        </aside>
      </section>
    </div>
  );
};

export default ProfilePage;
