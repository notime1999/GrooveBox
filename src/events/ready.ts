export default (client: import('discord.js').Client) => {
    client.once('ready', () => {
        console.log(`Logged in as ${client.user?.tag}!`);
    });
};