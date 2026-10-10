import { PermissionFlagsBits } from 'discord.js';

import { config } from '../config.js';

// DJs: admins, Manage Server/Channels, any configured DJ_ROLE_ID, or a role literally named "DJ".
export function isDJ(interaction){
  const perms = interaction.memberPermissions;
  if (perms?.has(PermissionFlagsBits.Administrator) || perms?.has(PermissionFlagsBits.ManageGuild) || perms?.has(PermissionFlagsBits.ManageChannels)) return true;
  const roles = interaction.member?.roles;
  const has = id => (roles?.cache ? roles.cache.has(id) : Array.isArray(roles) && roles.includes(id));
  if (config.djRoleIds.some(has)) return true;
  if (roles?.cache?.some(r => r.name.toLowerCase() === 'dj')) return true;
  return false;
}
