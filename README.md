# TradeHeaven Discord Middleman Ticket Bot

A Discord ticket bot for safer game-item and Robux trades. It creates private trade tickets, assigns verified Middlemen, collects trader confirmations, posts a single completed-trade history embed, and deletes closed ticket channels.

## Setup

1. Create a Discord application and bot, then invite it with the bot and applications.commands scopes.
2. Give the bot permission to manage channels, send messages, embed links, attach files, and read message history.
3. Set the DISCORD_BOT_TOKEN environment secret.
4. Optionally set DISCORD_GUILD_ID to register commands immediately in one server; without it, commands register globally.
5. Run pnpm install and pnpm start.
6. In Discord, run /ticket-setup once to select the Middleman role and history channel.

## Commands

- /ticket-setup — configure role and history channel
- /ticket — post the private ticket panel
- /claim — claim a ticket as a Middleman
- /confirm — confirm or deny trade details
- /close — write history and delete the ticket channel
- /mminfo — show the Middleman safety information
- /trust — show anti-scam guidance

The bot never includes credentials or token values in the repository.
