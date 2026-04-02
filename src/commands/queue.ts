import {
    ChatInputCommandInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    GuildMember
} from 'discord.js';
import GuildPlayer from '../audio/guildPlayer';
import { buildQueueList } from './play';

export const execute = async (interaction: ChatInputCommandInteraction) => {
    const member = interaction.member as GuildMember;
    const guild = interaction.guild;
    if (!guild) return interaction.reply('Command only for servers.');

    const gp = GuildPlayer.get(guild.id);
    if (!gp) return interaction.reply('No queue found.');

    await gp.deleteQueueMessage(interaction.client);

    const nowPlaying = gp.getCurrent();
    const maxQueueToShow = 10;
    const more = gp.queue.length > maxQueueToShow ? `\n...and ${gp.queue.length - maxQueueToShow} more` : '';
    let queueStr = buildQueueList(gp.queue.slice(0, maxQueueToShow)) + more;
    if (!queueStr.trim()) queueStr = 'No tracks in queue.';
    if (queueStr.length > 1024) queueStr = queueStr.slice(0, 1021) + '...';

    const embed = new EmbedBuilder()
        .setTitle('Music Queue')
        .addFields(
            { name: 'Now playing', value: nowPlaying?.title ?? 'Nothing' },
            { name: 'Queue', value: queueStr }
        );

    if (nowPlaying?.thumbnail) {
        embed.setThumbnail(nowPlaying.thumbnail);
    } else if (nowPlaying?.url && nowPlaying.url.includes('youtube.com')) {
        const videoId = nowPlaying.url.match(/[?&]v=([^&]+)/)?.[1];
        if (videoId) {
            embed.setThumbnail(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`);
        }
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
    const sent = await interaction.fetchReply();
    gp.queueMessageId = sent.id;
    gp.queueChannelId = sent.channelId;
};