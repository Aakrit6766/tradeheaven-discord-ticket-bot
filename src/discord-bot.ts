import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GuildMember,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type RepliableInteraction,
} from "discord.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger";

const FOOTER_ASSET_FILENAME = "tradeheaven-footer.jpg";
const DATA_FILENAME = "ticket-bot.json";
const MAX_TEXT_LENGTH = 1_000;

type BotConfig = {
  middlemanRoleId: string;
  historyChannelId: string;
};

type TicketState = {
  channelId: string;
  creatorId: string;
  otherTraderId?: string;
  otherTraderLabel?: string;
  game: string;
  tradeDetails: string;
  tradeValue: string;
  createdAt: string;
  claimedBy?: string;
  confirmations: string[];
  confirmationPromptMessageId?: string;
  deniedBy?: string;
  status: "open" | "closed";
};

type StoredData = {
  config?: BotConfig;
  tickets: Record<string, TicketState>;
};

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.resolve(sourceDir, "..");
const dataDir = path.resolve(process.env["TICKET_DATA_DIR"] ?? path.join(artifactDir, "data"));
const dataPath = path.join(dataDir, DATA_FILENAME);
const footerAssetCandidates = [
  path.join(artifactDir, "assets", FOOTER_ASSET_FILENAME),
  path.join(process.cwd(), "assets", FOOTER_ASSET_FILENAME),
];

let storedData: StoredData = { tickets: {} };
let footerAssetPath = footerAssetCandidates[0]!;

const ticketSetupCommand = new SlashCommandBuilder()
  .setName("ticket-setup")
  .setDescription("Configure the Middleman role and completed-trade history channel.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
  .addRoleOption((option) =>
    option
      .setName("middleman-role")
      .setDescription("Role allowed to claim and manage tickets.")
      .setRequired(true),
  )
  .addChannelOption((option) =>
    option
      .setName("history-channel")
      .setDescription("Text channel for completed ticket history.")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true),
  );

const commandBuilders = [
  ticketSetupCommand,
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Post the Middleman Request panel."),
  new SlashCommandBuilder().setName("claim").setDescription("Claim this trade ticket."),
  new SlashCommandBuilder().setName("close").setDescription("Close and archive this trade ticket."),
  new SlashCommandBuilder()
    .setName("confirm")
    .setDescription("Confirm or deny that the trade information is correct.")
    .addStringOption((option) =>
      option
        .setName("choice")
        .setDescription("Your decision about the trade information.")
        .setRequired(true)
        .addChoices(
          { name: "Confirm — information is correct", value: "confirm" },
          { name: "Deny — information needs changes", value: "deny" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("mminfo")
    .setDescription("Explain how the Middleman process works."),
  new SlashCommandBuilder()
    .setName("trust")
    .setDescription("Show the server's anti-scam and verification guidance."),
];

const commands = commandBuilders.map((command) =>
  command.setDMPermission(false).toJSON(),
);

function trimText(value: string): string {
  const cleaned = value.trim();
  return cleaned.length > MAX_TEXT_LENGTH
    ? `${cleaned.slice(0, MAX_TEXT_LENGTH - 1)}…`
    : cleaned;
}

async function loadData(): Promise<void> {
  try {
    storedData = JSON.parse(await readFile(dataPath, "utf8")) as StoredData;
    storedData.tickets ??= {};
  } catch {
    storedData = { tickets: {} };
  }

  for (const candidate of footerAssetCandidates) {
    try {
      await readFile(candidate);
      footerAssetPath = candidate;
      return;
    } catch {
      // Try the next known workspace location.
    }
  }
}

async function saveData(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dataPath, `${JSON.stringify(storedData, null, 2)}\n`, "utf8");
}

function getTicket(interaction: Interaction): TicketState | undefined {
  return interaction.channelId ? storedData.tickets[interaction.channelId] : undefined;
}

function isParticipant(ticket: TicketState, userId: string): boolean {
  return ticket.creatorId === userId || ticket.otherTraderId === userId;
}

function getOtherTraderDisplay(ticket: TicketState): string {
  if (ticket.otherTraderId) return `<@${ticket.otherTraderId}>`;
  const label = (ticket.otherTraderLabel ?? "Not resolved").replaceAll("`", "'");
  return `\`${label}\``;
}

function isMiddleman(interaction: Interaction): boolean {
  const roleId = storedData.config?.middlemanRoleId;
  if (!roleId || !interaction.guild) return false;
  const member = interaction.member;
  if (!member || !("roles" in member)) return false;
  return Array.isArray(member.roles)
    ? member.roles.includes(roleId)
    : member.roles.cache.has(roleId);
}

function getTicketControls(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:claim")
      .setLabel("Claim ticket")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Close ticket")
      .setStyle(ButtonStyle.Danger),
  );
}

function getConfirmationControls(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("confirmation:confirm")
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("confirmation:deny")
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );
}

function getConfirmationPrompt(ticket: TicketState): {
  content: string;
  embeds: [EmbedBuilder];
  components: [ActionRowBuilder<ButtonBuilder>];
  allowedMentions: { users: string[] };
} {
  const users = [ticket.creatorId, ...(ticket.otherTraderId ? [ticket.otherTraderId] : [])];
  const otherTraderText = ticket.otherTraderId
    ? `<@${ticket.otherTraderId}>`
    : `the other trader (${getOtherTraderDisplay(ticket)})`;

  return {
    content:
      `<@${ticket.creatorId}> ${otherTraderText}\n` +
      "Please review the confirmation below.",
    embeds: [
      buildNoticeEmbed(
        "Trade details confirmation",
        "Choose Confirm if the trade information above is correct, or Deny if it needs changes.",
        0xf2b138,
      ),
    ],
    components: [getConfirmationControls()],
    allowedMentions: { users },
  };
}

async function sendConfirmationPrompt(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  ticket: TicketState,
): Promise<void> {
  if (ticket.confirmationPromptMessageId) return;
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) return;

  const prompt = await channel.send(getConfirmationPrompt(ticket));
  ticket.confirmationPromptMessageId = prompt.id;
  await saveData();
}

function getFooterAttachment(): AttachmentBuilder {
  return new AttachmentBuilder(footerAssetPath, { name: FOOTER_ASSET_FILENAME });
}

function buildNoticeEmbed(title: string, description: string, color = 0x7357ff): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "TradeHeaven Middleman" })
    .setTimestamp();
}

function buildTicketEmbed(ticket: TicketState): EmbedBuilder {
  const confirmationStatus =
    ticket.confirmations.length === 2
      ? "Both traders confirmed"
      : `${ticket.confirmations.length}/2 traders confirmed`;

  return new EmbedBuilder()
    .setColor(0x7357ff)
    .setTitle("Middleman Request")
    .setDescription(
      "Found a trade? Keep both sides protected by using a verified Middleman. Review the details below before proceeding.",
    )
    .addFields(
      { name: "Other trader", value: getOtherTraderDisplay(ticket), inline: true },
      { name: "Game", value: ticket.game, inline: true },
      { name: "Trade value", value: ticket.tradeValue, inline: true },
      { name: "Trade details", value: ticket.tradeDetails },
      { name: "Trade agreement", value: "Both parties must confirm these details before the Middleman proceeds." },
      {
        name: "Confirmation status",
        value: ticket.deniedBy ? `${confirmationStatus} • changes requested` : confirmationStatus,
      },
      {
        name: "Important notes",
        value:
          "• Never share passwords, cookies, recovery codes, or private keys.\n" +
          "• A Middleman will never ask for your account login.\n" +
          "• Fake or troll tickets may be moderated.",
      },
    )
    .setImage(`attachment://${FOOTER_ASSET_FILENAME}`)
    .setFooter({ text: "TradeHeaven Middleman • Verify every detail" })
    .setTimestamp(new Date(ticket.createdAt));
}

function buildTicketModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("ticket:create")
    .setTitle("Middleman Request")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("other-trader")
          .setLabel("Other trader name, ID, or @mention")
          .setPlaceholder("Any name, @username, or Discord user ID")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("game")
          .setLabel("What is the name of the game?")
          .setPlaceholder("Example: Adopt Me, Blox Fruits, Pet Simulator")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("trade-details")
          .setLabel("What is the trade?")
          .setPlaceholder("Describe what each trader is giving and receiving.")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(MAX_TEXT_LENGTH),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("trade-value")
          .setLabel("Trade value")
          .setPlaceholder("Example: 1,200 Robux or $50")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
    );
}

async function resolveUserId(input: string, guild: Guild): Promise<string | undefined> {
  const cleanedInput = input.trim();
  const id = cleanedInput.match(/^<@!?(\d+)>$/)?.[1] ?? cleanedInput.match(/^\d+$/)?.[0];

  if (id) {
    try {
      const member = await guild.members.fetch(id);
      return member.user.bot ? undefined : member.id;
    } catch {
      return undefined;
    }
  }

  const searchTerm = cleanedInput.replace(/^@/, "").toLowerCase();
  if (!searchTerm) return undefined;

  const cachedMember = guild.members.cache.find(
    (member) =>
      member.user.username.toLowerCase() === searchTerm ||
      member.user.globalName?.toLowerCase() === searchTerm ||
      member.displayName.toLowerCase() === searchTerm,
  );
  if (cachedMember && !cachedMember.user.bot) return cachedMember.id;

  try {
    const matches = await guild.members.search({ query: searchTerm, limit: 10 });
    const match = matches.find(
      (member) =>
        !member.user.bot &&
        (member.user.username.toLowerCase() === searchTerm ||
          member.user.globalName?.toLowerCase() === searchTerm ||
          member.displayName.toLowerCase() === searchTerm),
    );
    return match?.id;
  } catch {
    return undefined;
  }
}

async function respondError(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ embeds: [buildNoticeEmbed("Action needed", content, 0xed4245)], ephemeral: true });
  } else {
    await interaction.reply({ embeds: [buildNoticeEmbed("Action needed", content, 0xed4245)], ephemeral: true });
  }
}

async function claimTicket(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const ticket = getTicket(interaction);
  if (!ticket) return respondError(interaction, "This command can only be used inside a ticket channel.");
  if (ticket.status === "closed") return respondError(interaction, "This ticket is already closed.");
  if (!isMiddleman(interaction)) {
    return respondError(interaction, "Only a member with the configured Middleman role can claim tickets.");
  }
  if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
    return respondError(interaction, `This ticket is already claimed by <@${ticket.claimedBy}>.`);
  }

  ticket.claimedBy = interaction.user.id;
  await saveData();
  await interaction.reply({
    embeds: [
      buildNoticeEmbed(
        "Middleman claimed",
        `<@${interaction.user.id}> is handling this trade.\nDo not send payment or items until both traders confirm the details.`,
        0x5865f2,
      ),
    ],
  });
  await sendConfirmationPrompt(interaction, ticket);
}

async function confirmTicket(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  decision: "confirm" | "deny",
): Promise<void> {
  const ticket = getTicket(interaction);
  if (!ticket) return respondError(interaction, "This command can only be used inside a ticket channel.");
  if (ticket.status === "closed") return respondError(interaction, "This ticket is already closed.");
  if (!isParticipant(ticket, interaction.user.id)) {
    return respondError(interaction, "Only the two traders listed in the ticket can confirm its details.");
  }
  await sendConfirmationPrompt(interaction, ticket);

  if (decision === "deny") {
    ticket.deniedBy = interaction.user.id;
    ticket.confirmations = ticket.confirmations.filter((id) => id !== interaction.user.id);
    await saveData();
    await interaction.reply({
      embeds: [
        buildNoticeEmbed(
          "Trade details denied",
          `<@${interaction.user.id}> has denied the trade details. Please review and update the information before proceeding.`,
          0xed4245,
        ),
      ],
    });
    return;
  }

  if (ticket.confirmations.includes(interaction.user.id)) {
    return respondError(interaction, "You have already confirmed these trade details.");
  }

  ticket.deniedBy = undefined;
  ticket.confirmations.push(interaction.user.id);
  await saveData();

  const complete = ticket.confirmations.length === 2;
  await interaction.reply({
    embeds: [
      buildNoticeEmbed(
        complete ? "Both traders confirmed" : "Trade details confirmed",
        complete
          ? `<@${interaction.user.id}> has confirmed the trade details.\nBoth traders have now confirmed. Wait for the claimed Middleman to guide the exchange.`
          : `<@${interaction.user.id}> has confirmed the trade details.`,
        0x26d94d,
      ),
    ],
  });
}

async function sendHistoryMessage(guild: Guild, ticket: TicketState): Promise<void> {
  const channelId = storedData.config?.historyChannelId;
  if (!channelId) return;
  const historyChannel = await guild.channels.fetch(channelId).catch(() => null);
  if (!historyChannel || historyChannel.type !== ChannelType.GuildText) return;

  const middleman = ticket.claimedBy ? `<@${ticket.claimedBy}>` : "Not claimed";
  const historyEmbed = new EmbedBuilder()
    .setColor(0x26d94d)
    .setTitle("TICKET COMPLETED")
    .setDescription("**Middleman trade completed and ticket closed.**")
    .addFields(
      { name: "Sender", value: `<@${ticket.creatorId}>`, inline: true },
      { name: "Receiver", value: getOtherTraderDisplay(ticket), inline: true },
      { name: "Middleman", value: middleman, inline: true },
      { name: "Game", value: ticket.game, inline: true },
      { name: "Trade value", value: ticket.tradeValue, inline: true },
      { name: "Trade details", value: ticket.tradeDetails },
      { name: "Status", value: "**TICKET COMPLETED**" },
    )
    .setFooter({ text: "TradeHeaven history • Keep personal information private" })
    .setTimestamp();

  await historyChannel.send({
    embeds: [historyEmbed],
  });
}

async function closeTicket(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const ticket = getTicket(interaction);
  if (!ticket) return respondError(interaction, "This command can only be used inside a ticket channel.");
  if (ticket.status === "closed") return respondError(interaction, "This ticket is already closed.");

  const allowed = isMiddleman(interaction) || ticket.claimedBy === interaction.user.id || ticket.creatorId === interaction.user.id;
  if (!allowed) {
    return respondError(interaction, "Only the Middleman, the claimant, or the ticket creator can close this ticket.");
  }

  const channel = interaction.channel;
  ticket.status = "closed";
  await saveData();

  await interaction.reply({
    embeds: [
      buildNoticeEmbed(
        "Ticket completed",
        "This ticket has been closed. The completed trade record was sent to the history channel.",
        0x26d94d,
      ),
    ],
  });

  if (interaction.guild) {
    await sendHistoryMessage(interaction.guild, ticket).catch((err: unknown) => {
      logger.error({ err, channelId: ticket.channelId }, "Failed to write ticket history");
    });
  }

  if (channel?.type === ChannelType.GuildText) {
    await channel.delete("Middleman ticket closed").catch((err: unknown) => {
      logger.error({ err, channelId: ticket.channelId }, "Failed to delete closed ticket channel");
    });
  }
}

function buildMiddlemanInfo(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xf2b138)
    .setTitle("How the Middleman service works")
    .setDescription(
      "A Middleman is a trusted go-between who holds payment until the seller delivers goods or services.",
    )
    .addFields(
      { name: "Why use one?", value: "Funds are released once the buyer confirms everything is as agreed." },
      {
        name: "Protection",
        value:
          "This process helps prevent scams, build trust, and resolve disputes. It can be useful for games, real-life money trades, in-game currency, and collectibles.",
      },
      {
        name: "Important",
        value: "Only use a Middleman who is reputable and verified. Never share passwords, cookies, or recovery codes.",
      },
      {
        name: "Reply format",
        value: "**START TRADE** + item + Robux amount\nLet’s do this safely!",
      },
    );
}

function buildTrustMessage(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("Scam safety check")
    .setDescription(
      "Never let a scam turn into another scam. Do not retaliate, sell accounts, or follow links promising quick money.",
    )
    .addFields(
      {
        name: "Before you trade",
        value:
          "Use the ticket system, verify the Middleman role, and confirm the exact items, value, and game with the other trader.",
      },
      {
        name: "Never share",
        value: "Passwords, cookies, recovery codes, 2FA codes, payment login details, or private keys.",
      },
      {
        name: "If something feels wrong",
        value: "Stop immediately, keep evidence, report the user to moderators, and contact the platform that processed payment.",
      },
    )
    .setFooter({ text: "Safe trades are verified trades" });
}

function requireGuild(interaction: ChatInputCommandInteraction): Guild | undefined {
  return interaction.guild ?? undefined;
}

async function handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  if (!guild) return respondError(interaction, "This command can only be used inside a server.");

  switch (interaction.commandName) {
    case "ticket-setup": {
      const role = interaction.options.getRole("middleman-role", true);
      const channel = interaction.options.getChannel("history-channel", true);
      if (channel.type !== ChannelType.GuildText) {
        return respondError(interaction, "The history channel must be a text channel.");
      }
      storedData.config = { middlemanRoleId: role.id, historyChannelId: channel.id };
      await saveData();
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(
            "Ticket system ready",
            `Middleman role: <@&${role.id}>\nHistory channel: <#${channel.id}>`,
            0x26d94d,
          ),
        ],
        ephemeral: true,
      });
      return;
    }
    case "ticket": {
      const panel = new EmbedBuilder()
        .setColor(0x7357ff)
        .setTitle("Make a Ticket")
        .setDescription(
          "Found a trade and want a safer experience? Start a private Middleman request below. The form asks for the other trader, the game, the trade details, and the value.",
        )
        .addFields(
          { name: "Trade details", value: "Both traders must confirm the information before proceeding." },
          { name: "Safety reminder", value: "Never share passwords, cookies, or recovery codes." },
        )
        .setImage(`attachment://${FOOTER_ASSET_FILENAME}`)
        .setFooter({ text: "TradeHeaven Middleman • Review everything carefully" });
      await interaction.reply({
        embeds: [panel],
        files: [getFooterAttachment()],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("ticket:start")
              .setLabel("Start trade")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      });
      return;
    }
    case "claim":
      await claimTicket(interaction);
      return;
    case "close":
      await closeTicket(interaction);
      return;
    case "confirm":
      await confirmTicket(interaction, interaction.options.getString("choice", true) as "confirm" | "deny");
      return;
    case "mminfo":
      await interaction.reply({
        embeds: [buildMiddlemanInfo()],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("mm:understand").setLabel("I understand").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("mm:questions").setLabel("I don't understand").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    case "trust":
      await interaction.reply({
        embeds: [buildTrustMessage()],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("trust:accept").setLabel("I understand").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("trust:decline").setLabel("I need help").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
  }
}

async function createTicketFromModal(interaction: Interaction & { isModalSubmit(): boolean }): Promise<void> {
  if (!interaction.isModalSubmit() || interaction.customId !== "ticket:create") return;
  const guild = interaction.guild;
  if (!guild) return respondError(interaction, "This form can only be used inside a server.");
  if (!storedData.config) {
    return respondError(interaction, "A server administrator must run `/ticket-setup` first.");
  }

  const otherTraderLabel = trimText(interaction.fields.getTextInputValue("other-trader"));
  const otherTraderId = await resolveUserId(otherTraderLabel, guild);
  if (otherTraderId === interaction.user.id) {
    return respondError(interaction, "The other trader must be different from you.");
  }

  const everyoneRole = await guild.roles.fetch(guild.id).catch(() => null);
  const middlemanRole = await guild.roles.fetch(storedData.config.middlemanRoleId).catch(() => null);
  const creatorMember = await guild.members.fetch(interaction.user.id).catch(() => null);
  const otherTraderMember = otherTraderId
    ? await guild.members.fetch(otherTraderId).catch(() => null)
    : null;
  if (!everyoneRole || !middlemanRole || !creatorMember) {
    return respondError(
      interaction,
      "The bot cannot load the server permissions. Please confirm it has Manage Channels and try again.",
    );
  }

  const ticket: TicketState = {
    channelId: "",
    creatorId: interaction.user.id,
    otherTraderId,
    otherTraderLabel,
    game: trimText(interaction.fields.getTextInputValue("game")),
    tradeDetails: trimText(interaction.fields.getTextInputValue("trade-details")),
    tradeValue: trimText(interaction.fields.getTextInputValue("trade-value")),
    createdAt: new Date().toISOString(),
    confirmations: [],
    status: "open",
  };

  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 18) || "trader";
  const permissionOverwrites = [
    { id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: creatorMember.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: middlemanRole.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
  ];
  if (otherTraderMember) {
    permissionOverwrites.push({
      id: otherTraderMember.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channel = await guild.channels.create({
    name: `trade-${safeName}`,
    type: ChannelType.GuildText,
    topic: `Private Middleman ticket • ${ticket.game}`,
    permissionOverwrites,
  });

  ticket.channelId = channel.id;
  storedData.tickets[channel.id] = ticket;
  await saveData();

  await channel.send({
    content: `<@${ticket.creatorId}> ${
      otherTraderId ? `<@${otherTraderId}>` : `Other trader reference: \`${otherTraderLabel.replaceAll("`", "'")}\``
    }`,
    embeds: [buildTicketEmbed(ticket)],
    files: [getFooterAttachment()],
    components: [getTicketControls()],
  });
  await interaction.reply({
    embeds: [buildNoticeEmbed("Private ticket created", `Your private ticket is ready: <#${channel.id}>`, 0x26d94d)],
    ephemeral: true,
  });
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  switch (interaction.customId) {
    case "ticket:start":
      await interaction.showModal(buildTicketModal());
      return;
    case "ticket:claim":
      await claimTicket(interaction);
      return;
    case "confirmation:confirm":
      await confirmTicket(interaction, "confirm");
      return;
    case "confirmation:deny":
      await confirmTicket(interaction, "deny");
      return;
    case "ticket:close":
      await closeTicket(interaction);
      return;
    case "mm:understand":
      await interaction.reply({
        embeds: [buildNoticeEmbed("Understood", "Start a trade with `/ticket` when both traders are ready.", 0x26d94d)],
        ephemeral: true,
      });
      return;
    case "mm:questions":
      await interaction.reply({
        embeds: [buildNoticeEmbed("Ask a moderator", "Please ask a moderator before sending anything. Never share account credentials.", 0xf2b138)],
        ephemeral: true,
      });
      return;
    case "trust:accept":
      await interaction.reply({
        embeds: [buildNoticeEmbed("Safety guidance accepted", "Keep trades inside the ticket system and verify every participant.", 0x26d94d)],
        ephemeral: true,
      });
      return;
    case "trust:decline":
      await interaction.reply({
        embeds: [buildNoticeEmbed("Pause the trade", "Please contact a moderator if anything feels unsafe.", 0xed4245)],
        ephemeral: true,
      });
  }
}

export async function startDiscordBot(): Promise<void> {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required to start the Discord ticket bot.");
  }

  await loadData();
  const client = new Client({ intents: [] });
  const rest = new REST({ version: "10" }).setToken(token);

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      const guildId = process.env["DISCORD_GUILD_ID"];
      if (guildId) {
        await rest.put(Routes.applicationGuildCommands(readyClient.user.id, guildId), { body: commands });
        logger.info({ guildId }, "Discord slash commands registered for guild");
      } else {
        await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
        logger.info("Discord global slash commands registered");
      }
      logger.info({ tag: readyClient.user.tag }, "Discord ticket bot is online");
    } catch (error) {
      logger.error({ err: error }, "Failed to register Discord slash commands");
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleChatCommand(interaction);
      } else if (interaction.isButton()) {
        await handleButton(interaction);
      } else if (interaction.isModalSubmit()) {
        await createTicketFromModal(interaction);
      }
    } catch (error) {
      logger.error({ err: error, interactionId: interaction.id }, "Discord interaction failed");
      if (interaction.isRepliable()) {
        await respondError(interaction as ChatInputCommandInteraction, "Something went wrong. A moderator should check the bot logs.").catch(() => undefined);
      }
    }
  });

  await client.login(token);
}