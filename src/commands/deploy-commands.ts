import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const commands = [
    new SlashCommandBuilder().setName('play').setDescription('Riproduci una canzone o playlist')
        .addStringOption(opt => opt.setName('query').setDescription('Nome o link').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('Salta la traccia corrente'),
    new SlashCommandBuilder().setName('stop').setDescription('Ferma la musica'),
    new SlashCommandBuilder().setName('queue').setDescription('Mostra la coda'),
].map(cmd => cmd.toJSON());

const token = process.env.DISCORD_TOKEN!;
const clientId = process.env.DISCORD_CLIENT_ID!;
const guildId = process.env.DISCORD_GUILD_ID!;

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    // Clear global commands (removes old duplicates)
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('Comandi globali rimossi.');

    // Register guild commands
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('Comandi registrati!');
})().catch(console.error);