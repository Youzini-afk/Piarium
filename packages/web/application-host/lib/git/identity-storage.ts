import fs from 'fs';
import path from 'path';
import { resolvePiariumDataDir } from '../platform/data-paths.js';

const STORAGE_DIR = resolvePiariumDataDir(process);
const STORAGE_FILE = path.join(STORAGE_DIR, 'git-identities.json');

export interface GitIdentityProfile {
  authType: string;
  color: string;
  host: string | null;
  icon: string;
  id: string;
  name: string;
  signCommits: boolean | undefined;
  signingKey: string | null;
  sshKey: string | null;
  userEmail: string;
  userName: string;
}

interface GitIdentityDocument { profiles: GitIdentityProfile[] }

function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

export function loadProfiles(): GitIdentityDocument {
  ensureStorageDir();

  if (!fs.existsSync(STORAGE_FILE)) {
    return { profiles: [] };
  }

  try {
    const content = fs.readFileSync(STORAGE_FILE, 'utf8');
    const data = JSON.parse(content) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || !Array.isArray((data as { profiles?: unknown }).profiles)) return { profiles: [] };
    return { profiles: (data as { profiles: GitIdentityProfile[] }).profiles };
  } catch (error) {
    console.error('Failed to load git identity profiles:', error);
    return { profiles: [] };
  }
}

export function saveProfiles(data: GitIdentityDocument): true {
  ensureStorageDir();

  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Failed to save git identity profiles:', error);
    throw error;
  }
}

export function getProfiles(): GitIdentityProfile[] {
  const data = loadProfiles();
  return data.profiles || [];
}

export function getProfile(id: string): GitIdentityProfile | null {
  const profiles = getProfiles();
  return profiles.find((profile) => profile.id === id) || null;
}

export function createProfile(profileData: Partial<GitIdentityProfile> & Pick<GitIdentityProfile, 'id' | 'userEmail' | 'userName'>): GitIdentityProfile {
  const profiles = getProfiles();

  if (profiles.some((profile) => profile.id === profileData.id)) {
    throw new Error(`Profile with ID "${profileData.id}" already exists`);
  }

  if (!profileData.id || !profileData.userName || !profileData.userEmail) {
    throw new Error('Profile must have id, userName, and userEmail');
  }

  const newProfile: GitIdentityProfile = {
    id: profileData.id,
    name: profileData.name || profileData.userName,
    userName: profileData.userName,
    userEmail: profileData.userEmail,
    authType: profileData.authType || 'ssh',
    sshKey: profileData.sshKey || null,
    signCommits: profileData.signCommits,
    signingKey: profileData.signingKey || null,
    host: profileData.host || null,
    color: profileData.color || 'keyword',
    icon: profileData.icon || 'branch'
  };

  profiles.push(newProfile);
  saveProfiles({ profiles });

  return newProfile;
}

export function updateProfile(id: string, updates: Partial<Omit<GitIdentityProfile, 'id'>>): GitIdentityProfile {
  const profiles = getProfiles();
  const index = profiles.findIndex((profile) => profile.id === id);

  if (index === -1) {
    throw new Error(`Profile with ID "${id}" not found`);
  }

  const existing = profiles[index]!;
  profiles[index] = {
    ...existing,
    ...updates,
    id: existing.id
  };

  saveProfiles({ profiles });
  return profiles[index]!;
}

export function deleteProfile(id: string): true {
  const profiles = getProfiles();
  const filteredProfiles = profiles.filter((profile) => profile.id !== id);

  if (filteredProfiles.length === profiles.length) {
    throw new Error(`Profile with ID "${id}" not found`);
  }

  saveProfiles({ profiles: filteredProfiles });
  return true;
}
