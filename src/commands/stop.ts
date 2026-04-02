import { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import GuildPlayer from '../audio/guildPlayer';

export const execute = async (interaction: ChatInputCommandInteraction) => {
    const member = interaction.member as GuildMember;
    if (!member || !member.voice?.channel) {
        return interaction.reply('You must be in a voice channel to use stop.');
    }
    const voiceChannel = member.voice.channel;
    const gp = GuildPlayer.get(voiceChannel.guild.id);
    if (!gp) return interaction.reply('No music playing.');

    await gp.stop();
    
    await interaction.reply({ content: 'Music stopped. Leaving channel.', ephemeral: true });
};