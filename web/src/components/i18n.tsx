import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];

const STORAGE_KEY = "pim-locale";

const translations = {
  en: {
    approvalRequested: "Pim needs your approval",
    approve: "Approve",
    alwaysApprove: "Always approve",
    moreApprovalOptions: "More approval options",
    yourPims: "Your Pims",
    yourPimsDescription:
      "Pims with their own instructions, like a running coach or a trip planner. They share your memory and apps; start a chat with one to get its instructions.",
    noPims: "No Pims yet. Make one, or find one others published.",
    newPim: "New Pim",
    editPim: "Edit Pim",
    findPims: "Find Pims",
    pimName: "Name",
    pimNamePlaceholder: "Marathon coach",
    pimDescription: "What it's for",
    pimDescriptionPlaceholder: "Plans my training week by week",
    pimInstructions: "Instructions",
    pimInstructionsPlaceholder:
      "How it should work: what to focus on, how to talk, what to ask before doing.",
    suggestedApps: "Apps it works with",
    suggestedAppsHint:
      "MCP server URLs. Whoever uses this Pim connects them with their own accounts.",
    appName: "App",
    appUrl: "MCP server URL",
    removeApp: "Remove app",
    addApp: "Add app",
    save: "Save",
    edit: "Edit",
    chatWithPim: "Chat",
    publish: "Publish",
    updatePublished: "Publish changes",
    unpublish: "Unpublish",
    published: "Published",
    pimPublished:
      "Published: anyone on this Pim can find it and make it their own.",
    pimUnpublished: "Unpublished.",
    deletePim: "Delete",
    deletePimNamed: "Delete {name}",
    fromTemplateBy: "From a Pim by",
    connected: "Connected",
    appConnected: "Connected.",
    startChatWith: "Start a chat with {name}.",
    messagePersona: "Message {name}…",
    discover: "Discover",
    discoverDescription:
      "Pims people published. Make one your own: you get a copy of its name and instructions, never anything of theirs.",
    searchPims: "Search Pims and people",
    noPimsMatch: "No Pims match.",
    noPimsPublished: "Nobody has published a Pim yet.",
    templateUses: "used {count}×",
    publishedBy: "Published by",
    noDescription: "A published Pim.",
    templateWarning:
      "Read its instructions first: your copy runs with your memory and your apps, and still asks before acting where you said it should.",
    makeItYourOwn: "Make it your own",
    youHaveACopy: "You already made it your own:",
    madeYourOwn: "{name} is one of your Pims now.",
    backToDiscover: "Discover",
    publishedPims: "Published Pims",
    nothingPublished: "Nothing published yet.",
    messageTheirPim: "Message {username}'s Pim",
    profile: "Profile",
    profileDescription:
      "How others on this Pim see you: on your page, and next to the Pims you publish.",
    displayName: "Name",
    bio: "About you",
    bioPlaceholder: "Runner, cook, always planning the next trip",
    sharing: "Sharing",
    sharingDescription:
      "Put people in circles to let them message your Pim from their own. They can use only what you give their circle, and their messages count against their own usage, not yours.",
    waitingForYou: "Waiting for you",
    circles: "Circles",
    noCircles:
      "No circles yet. Make one, like Family or Close friends, then add people by their username.",
    circleNamePlaceholder: "Family, Close friends…",
    newCircle: "New circle",
    circleMembers: "People: {count}",
    circlePaused: "Paused: nobody in it can message your Pim",
    shareWithCircle: "Share with {circle}",
    deleteCircle: "Delete",
    deleteCircleNamed: "Delete {circle}",
    membersOf: "People in {circle}",
    removeMember: "Remove {username} from {circle}",
    usernamePlaceholder: "Their username",
    addTo: "Add someone to {circle}",
    add: "Add",
    whatCircleCanUse: "What {circle} can use",
    circlePermissionsDescription:
      "Everything starts off. Ask: you approve each request. On: they use it without asking you. These tools act on your accounts.",
    recentActivity: "Recent activity",
    activityRan: "used",
    activityAsked: "asked you",
    activityRefused: "refused",
    guestAsked: "{username} ({circle}) asks",
    alwaysApproveForCircle: "Always approve for {circle}",
    memoryTool: "Memory",
    memoryToolDescription:
      "What your Pim remembers about you: they can read and search it, never change it.",
    toolChangedCircle:
      "Changed by the app since you allowed it, so it's off for this circle until you choose again.",
    sharedWithYou: "Shared with you",
    visitEmptyTitle: "Message {username}'s Pim",
    visitEmptyHint:
      "It answers for {username}, with what they share with you. Anything they want to approve goes to them first.",
    messageVisit: "Message {username}'s Pim…",
    visitPim: "{username}'s Pim",
    visitUnavailable: "No longer shared",
    visitBanner:
      "You're messaging {username}'s Pim. It acts for {username}, within what they allow you. Your messages use your own usage.",
    toolPermissions: "Tool permissions",
    toolPermissionsDescription:
      "What Pim may do with each tool. Off: Pim can't use it. Ask: Pim waits for your approval. On: Pim uses it without asking.",
    pimTools: "Pim",
    permissionOff: "Off",
    permissionAsk: "Ask",
    permissionOn: "On",
    permissionFor: "Permission for {tool}",
    useDefaultPermission: "Back to the default for {tool}",
    readOnlyTool: "Read-only",
    toolChanged:
      "Changed by the app since you chose On, so Pim asks again. Choose again to trust the new version.",
    toolCount: "Tools: {count}",
    awaitingApproval: "Waiting for your approval",
    approved: "Approved",
    arguments: "Arguments",
    cancelRename: "Cancel rename",
    chatNotFound: "This chat doesn't exist.",
    chatOptions: "Chat options",
    chats: "Chats",
    close: "Close",
    collapseSidebar: "Collapse sidebar",
    completed: "Completed",
    connecting: "Connecting…",
    copied: "Copied",
    couldNotReachPim: "Couldn't reach Pim",
    copy: "Copy",
    copyMessage: "Copy message",
    deleteChat: "Delete",
    confirmDeleteChat: "Confirm",
    copyResponse: "Copy response",
    darkTheme: "Dark theme",
    denied: "Denied",
    deny: "Deny",
    details: "Details",
    emptyChatHint:
      "Ask anything, or have Pim remember, schedule, or watch something for you.",
    emptyChatTitle: "What can I do for you?",
    english: "English",
    failed: "Failed",
    expandSidebar: "Expand sidebar",
    language: "Language",
    lightTheme: "Light theme",
    markAllRead: "Mark all as read",
    markRead: "Mark as read",
    messagePim: "Message Pim…",
    moreActions: "More actions",
    navigation: "Navigation",
    newChat: "New chat",
    noChatsMatch: "No chats match your search.",
    noChatsYet: "No chats yet.",
    noNotifications: "No notifications yet.",
    notifications: "Notifications",
    notificationsDescription: "What Pim told you while you were away.",
    pushNotifications: "Push notifications",
    pushDescription:
      "Get Pim's notifications on this device, even when the app is closed.",
    pushBlocked:
      "Notifications are blocked for this site. Allow them in your browser's settings.",
    pushUnsupported:
      "This browser can't receive push notifications. On an iPhone or iPad, add Pim to your Home Screen first.",
    older: "Older",
    openChat: "Open chat",
    openSidebar: "Open sidebar",
    pending: "Pending",
    pimCanMakeMistakes: "Pim can make mistakes. Check important info.",
    preferences: "Preferences",
    previous30Days: "Previous 30 days",
    previous7Days: "Previous 7 days",
    queuedMessages: "Queued messages: {count}",
    reload: "Reload",
    rename: "Rename",
    result: "Result",
    retryingAfterError: "Retrying after a model error…",
    review: "Review",
    running: "Running",
    saveName: "Save name",
    searchChats: "Search chats",
    sendMessage: "Send message",
    showReasoning: "Show reasoning",
    signInExpired: "Your sign-in expired",
    spanish: "Spanish",
    startNewChat: "Start a new chat",
    stopGenerating: "Stop generating",
    systemTheme: "System theme",
    theme: "Theme",
    thinking: "Thinking...",
    thoughtForSeconds: "Thought for {duration} second{suffix}",
    thoughtProcess: "Thought process",
    today: "Today",
    tryAgain: "Try again",
    uploadFiles: "Upload files",
    view: "View",
    working: "Working",
    yesterday: "Yesterday",
    cancel: "Cancel",
    chatGPTPlanPitch:
      "Run Pim on OpenAI's models, such as GPT-6.1 Sol, with usage included in your ChatGPT Plus or Pro plan. When you're not connected, Pim uses its default model on Workers AI.",
    chatGPTWhyPaste:
      "OpenAI's sign-in for open-source apps can only send you back to an address on your own device (127.0.0.1), which Pim can't receive from the internet. So you carry that address over to Pim yourself, this once.",
    chatGPTStepApprove: "In the new tab, sign in to ChatGPT and approve Pim.",
    chatGPTStepCopy:
      "The tab ends on a 127.0.0.1 page that doesn't load. That's expected. Copy the whole address from its address bar.",
    chatGPTStepPaste:
      "Paste it below, here in your own Pim, within 15 minutes. It holds a one-time code that finishes the sign-in, so don't paste it anywhere else.",
    chatGPTAfterPaste:
      "After this, Pim normally keeps the connection going on its own. If access expires or is revoked in ChatGPT, connect again the same way.",
    connect: "Connect",
    connectForMoreModels:
      "Connect your ChatGPT plan to choose OpenAI's models.",
    connectedAs:
      "Connected as {email}. Pim's requests to OpenAI models use your plan.",
    continueWithChatGPT: "Continue with ChatGPT",
    couldNotListModels: "Couldn't list your ChatGPT models: {error}",
    disconnect: "Disconnect",
    gotIt: "Got it",
    manageUsage: "Manage usage",
    modelUsageLimit:
      "Pim has used up its ChatGPT allowance, so it couldn't answer. That's either your plan's usage limit or Pim's own limit under App limits, which you can raise. Both reset on their own; ChatGPT's usage page shows when. Until then, you can switch Pim to its Workers AI model in Settings.",
    modelQuota:
      "Pim's daily usage quota is used up, so it couldn't answer. It resets at midnight UTC.",
    modelSignIn:
      "Pim couldn't use your ChatGPT connection, so it couldn't answer. Connect ChatGPT again in Settings.",
    modelTooLong:
      "This chat is too long for the model, so Pim couldn't answer. Start a new chat.",
    modelBusy:
      "The model provider is busy or unreachable, so Pim couldn't answer. Try again in a moment.",
    modelOther:
      "The model couldn't answer. Try again, or switch models in Settings.",
    notAnswered: "Not answered: {reason}",
    taskFailed: "Something went wrong, so Pim couldn't finish. Try again.",
    model: "Model",
    modelChanged: "Pim now uses {model}",
    pasteAddress: "Address the browser landed on",
    runsOnWorkersAI: "Runs on Workers AI",
    tryItModel: "Try-it model: free on Workers AI, not for real use",
    settings: "Settings",
    artifacts: "Artifacts",
    artifactsDescription:
      "Documents and pages Pim made for you, with every version. They're kept until you delete them.",
    noArtifacts:
      "None yet. Ask Pim for a page, a tool or a document, and it appears here.",
    allArtifacts: "All artifacts",
    artifactSummary: "{kind} · version {version} · {size}",
    artifactVersion: "Version {version}",
    artifactVersionOption: "Version {version} · {date}",
    artifactVersionRestoredOption: "Version {version} (from {from}) · {date}",
    artifactVersionDetails: "Version {version} of {latest} · {size} · {sha}",
    artifactHistory: "Version",
    artifactPreview: "Preview",
    artifactSource: "Source",
    artifactRestore: "Restore version {version}",
    artifactRestored: "Version {from} restored as version {version}",
    artifactDelete: "Delete artifact",
    artifactDeleteConfirm:
      'Delete "{title}" and all {versions} of its versions? Chats where Pim made it still show what it wrote there until you delete those chats.',
    artifactDeleted: "This artifact was deleted.",
    artifactVersionMissing: "This artifact has no version {version}.",
    artifactLatest: "Open the latest, version {version}",
    artifactDeletedToast: "Artifact deleted",
    artifactCaution:
      "Made by Pim. It runs in a sandbox, apart from your account, but it could still send what it shows, or what you type into it, to another site. Don't enter passwords or codes.",
    artifactNavigated:
      "This artifact tried to open another page, so Pim stopped showing it. Anything it put in that page's address may have been sent.",
    artifactShowAgain: "Show it again",
    loading: "Loading…",
    open: "Open",
    settingsDescription: "The model Pim runs on, and the accounts it uses.",
    useYourChatGPTPlan: "Use your ChatGPT plan",
    usesChatGPTPlan: "Uses your ChatGPT plan",
    usingChatGPTPlan: "Using ChatGPT plan",
    usingYourPlanBody:
      "Pim's requests to OpenAI models now use your ChatGPT plan. You can review and cap Pim's usage in ChatGPT settings.",
    usingYourPlanTitle: "You're using your ChatGPT plan",
    yourAccount: "your account",
    addPasskey: "Add a passkey",
    createPasskey: "Create passkey",
    passkeyAdded: "Passkey added",
    passkeyDates: "Added {created} · Last used {used}",
    passkeys: "Passkeys",
    passkeysDescription:
      "Passkeys sign you in to Pim. Removing one signs out the browsers it signed in.",
    removeCurrentPasskey:
      "This browser signed in with it, so removing it signs you out.",
    removePasskey: "Remove {name}",
    signInBody: "Use the passkey on this device, or one on your phone.",
    signInTitle: "Sign in to Pim",
    signInWithPasskey: "Sign in with a passkey",
    signOut: "Sign out",
    thisBrowser: "This browser",
    createPasskeyBody:
      "This setup link adds a passkey to your account, once. Your device will ask for your face, fingerprint, or PIN.",
    createPasskeyTitle: "Create your passkey",
    backToSignIn: "Back to sign in",
    getSetupLinkBody:
      "A setup link adds a passkey to the account of whoever runs this Pim. Pim just wrote one to its logs in your Cloudflare account, where only you can read it.",
    getSetupLinkTitle: "Get a setup link",
    lostPasskey: "Lost your passkey?",
    openCloudflareDashboard: "Open the Cloudflare dashboard",
    setUpBody:
      "Nobody has set up this Pim yet. Anyone can do it from this page only in the 15 minutes after deploying, so now it takes a setup link. Pim just wrote one to its logs in your Cloudflare account, where only you can read it.",
    claimBody:
      "You're the first one here, so you'll run this Pim: you invite others, and help them back in if they lose every passkey. Pick your username, then create a passkey on this device.",
    setUpTitle: "Set up Pim",
    setupLinkWritten: "Link written to the logs. It works once, for an hour.",
    setupStepDashboard:
      "In the Cloudflare dashboard, open Workers & Pages, then your Pim Worker, then Observability.",
    setupStepOpen:
      "Find the log that starts with “Pim setup link” and open its link on the device you want to sign in with.",
    writeLinkAgain: "Write the link again",
    writingSetupLink: "Writing a setup link to the logs…",
    approvedNoAnswer: "Approved: no answer in time",
    deniedNoAnswer: "Denied: no answer in time",
    recoveryCodeTitle: "Use a recovery code",
    recoveryCodeBody:
      "Enter your username and one of the recovery codes you saved when you joined. It adds a passkey on this device, and works once.",
    recoveryCode: "Recovery code",
    registerTitle: "Join this Pim",
    registerBody:
      "A personal agent that remembers what matters to you, keeps working while you're away, and asks before acting. Pick the username others here will know you by.",
    registrationClosed: "This Pim isn't taking new people right now.",
    username: "Username",
    usernameHint: "Lowercase letters, digits, and hyphens.",
    usernameAvailable: "{username} is available",
    inviteCode: "Invite code",
    registerFootnote:
      "Next you'll save recovery codes, then create a passkey on this device. There's no password.",
    recoveryCodesFileHeader:
      "Recovery codes for {username} on {host}. Each adds a passkey once.",
    saveRecoveryCodesTitle: "Save your recovery codes",
    saveRecoveryCodesBody:
      "If you lose your passkey, one of these gets you back in. Each works once, and they won't be shown again.",
    recoveryCodes: "Recovery codes",
    download: "Download",
    savedRecoveryCodes: "I saved my recovery codes somewhere safe.",
    exportData: "Export my data",
    accountUsageToday: "What you used today. Limits reset at midnight UTC.",
    usageTokens: "Tokens",
    usageRuns: "Runs",
    usageModelRequests: "Model requests",
    usedOf: "{used} of {limit}",
    planTokensToday:
      "Plus {tokens} tokens on your ChatGPT plan, which don't count here.",
    recoveryCodesLeft: "Recovery codes left: {count}",
    newRecoveryCodes: "New recovery codes",
    newRecoveryCodesBody:
      "Your old codes no longer work. Save these now: they won't be shown again.",
    settingsSaved: "Saved",
    timeZone: "Time zone",
    approvalPolicy: "When you don't answer",
    approvalPolicyDescription:
      "When Pim asks before acting and you don't answer in time:",
    approvalExplicit: "Deny it",
    approvalExplicitBody:
      "Pim waits 5 minutes, then doesn't act. Nothing happens without a yes.",
    approvalAuto: "Approve it",
    approvalAutoBody:
      "Pim waits 30 seconds, then acts, so background work never stalls.",
    apiTokens: "API tokens",
    apiTokensDescription:
      "Tokens let apps and scripts use Pim's API. Each one can do anything you can, except manage sign-in.",
    tokenDates: "Created {created} · Last used {used}",
    never: "never",
    revokeToken: "Revoke {name}",
    tokenShownOnce: "Copy your new token now. It won't be shown again.",
    tokenName: "Token name",
    tokenNamePlaceholder: "What will use it, such as “Phone”",
    createToken: "Create token",
    deleteAccount: "Delete account",
    deleteAccountBody:
      "Deletes {username}'s Pim: conversations, memories, goals, connected apps, and passkeys. It can't be undone, and the username won't be available again.",
    typeUsernameToConfirm: "Type {username} to confirm",
    deleteForever: "Delete forever",
    deleteAccountButton: "Delete my account…",
    addThisDeviceTitle: "Add this device",
    addingTo: "Adding this device to",
    passkeyAlreadyHere:
      "This device already has a passkey for this Pim, so it doesn't need another. Sign in with it instead.",
    signInWithThisPasskey: "Sign in with my passkey",
    addDeviceCancelFailed:
      "Couldn't end the link ({error}), so it may still work until it expires. Try again.",
    addThisDeviceBody:
      "Your Pim sent this link from a device where you're signed in. Create a passkey here, and this device can sign in on its own from now on.",
    addThisDeviceNote:
      "The link works once, for 10 minutes. Your other devices and passkeys stay as they are.",
    newDeviceTitle: "Signed up on another device?",
    newDeviceBody:
      "A passkey lives on the device that made it, unless your password manager syncs it here. On a device where you're signed in, open Settings → Passkeys → Add another device and scan the code. No other device? Use a recovery code.",
    addDeviceTitle: "Add another device",
    addDeviceBody:
      "Sign in on your phone or another computer: it makes its own passkey from a one-time link.",
    addDeviceButton: "Add another device",
    addDeviceQr: "QR code with a link that adds another device",
    addDeviceStepScan:
      "On the other device, scan this code with the camera, or open the link.",
    addDeviceStepPasskey: "Tap Create passkey there.",
    addDeviceExpires:
      "Works once, until {time}. Anyone with this link can add a device, so only open it yourself.",
    addDeviceExpired: "That link expired. Make a new one.",
    copyLink: "Copy link",
    done: "Done",
    accountClosedTitle: "Your account is closed",
    accountClosedBody:
      "Nobody can use it anymore, but erasing its data hasn't finished yet. Pim keeps retrying until everything is erased; you don't need to do anything.",
    adminBadge: "Admin",
    you: "you",
    leave: "Leave",
    members: "People on this Pim",
    membersDescription:
      "Everyone who joined. Invite someone with a link that works once. For someone who lost every passkey and recovery code, make a setup link.",
    inviteSomeone: "Invite someone",
    inviteLinkNote:
      "Works once. Anyone with it can join, so send it only to the person you mean.",
    setupLinkFor:
      "Adds a passkey to @{username}'s account, once, within an hour. Send it only to them.",
    setupLinkAction: "Setup link for @{username}",
    memberPending: "Hasn't made a passkey yet",
    memberSuspended: "Suspended",
    memberDeleting: "Being erased",
    suspendMember: "Suspend @{username}",
    restoreMember: "Restore @{username}",
    deleteMember: "Delete @{username}",
    becomeAdmin: "Set up this Pim",
    createAccount: "Create my account",
    firstPasskeyNote:
      "Your device will ask for your face, fingerprint, or PIN. Add your other devices later, from Settings.",
    notMyPim: "This isn't my Pim",
    newHere: "New here?",
    joinByInvite: "New here? Ask whoever runs this Pim for an invite link.",
    adminLostPasskey: "Run this Pim and lost every passkey?",
    getSetupLinkFromLogs: "Get a setup link from the logs",
  },
  es: {
    approvalRequested: "Pim necesita tu aprobación",
    approve: "Aprobar",
    alwaysApprove: "Aprobar siempre",
    moreApprovalOptions: "Más opciones de aprobación",
    yourPims: "Tus Pims",
    yourPimsDescription:
      "Pims con sus propias instrucciones, como un entrenador de running o un planificador de viajes. Comparten tu memoria y tus apps; empieza un chat con uno para usar sus instrucciones.",
    noPims: "Aún no hay Pims. Crea uno, o busca uno que otros publicaron.",
    newPim: "Nuevo Pim",
    editPim: "Editar Pim",
    findPims: "Buscar Pims",
    pimName: "Nombre",
    pimNamePlaceholder: "Entrenador de maratón",
    pimDescription: "Para qué sirve",
    pimDescriptionPlaceholder: "Planea mi entrenamiento semana a semana",
    pimInstructions: "Instrucciones",
    pimInstructionsPlaceholder:
      "Cómo debe trabajar: en qué enfocarse, cómo hablar, qué preguntar antes de actuar.",
    suggestedApps: "Apps con las que trabaja",
    suggestedAppsHint:
      "URLs de servidores MCP. Quien use este Pim las conecta con sus propias cuentas.",
    appName: "App",
    appUrl: "URL del servidor MCP",
    removeApp: "Quitar app",
    addApp: "Añadir app",
    save: "Guardar",
    edit: "Editar",
    chatWithPim: "Chatear",
    publish: "Publicar",
    updatePublished: "Publicar cambios",
    unpublish: "Dejar de publicar",
    published: "Publicado",
    pimPublished:
      "Publicado: cualquiera en este Pim puede encontrarlo y hacerlo suyo.",
    pimUnpublished: "Ya no está publicado.",
    deletePim: "Eliminar",
    deletePimNamed: "Eliminar {name}",
    fromTemplateBy: "De un Pim de",
    connected: "Conectada",
    appConnected: "Conectada.",
    startChatWith: "Empieza un chat con {name}.",
    messagePersona: "Escribe a {name}…",
    discover: "Descubrir",
    discoverDescription:
      "Pims que otros publicaron. Haz uno tuyo: recibes una copia de su nombre e instrucciones, nunca nada suyo.",
    searchPims: "Busca Pims y personas",
    noPimsMatch: "Ningún Pim coincide.",
    noPimsPublished: "Nadie ha publicado un Pim todavía.",
    templateUses: "usado {count}×",
    publishedBy: "Publicado por",
    noDescription: "Un Pim publicado.",
    templateWarning:
      "Lee primero sus instrucciones: tu copia funciona con tu memoria y tus apps, y sigue preguntando antes de actuar donde lo pediste.",
    makeItYourOwn: "Hacerlo mío",
    youHaveACopy: "Ya lo hiciste tuyo:",
    madeYourOwn: "{name} ya es uno de tus Pims.",
    backToDiscover: "Descubrir",
    publishedPims: "Pims publicados",
    nothingPublished: "Nada publicado todavía.",
    messageTheirPim: "Escribir al Pim de {username}",
    profile: "Perfil",
    profileDescription:
      "Cómo te ven otros en este Pim: en tu página y junto a los Pims que publicas.",
    displayName: "Nombre",
    bio: "Sobre ti",
    bioPlaceholder: "Corredora, cocinera, siempre planeando el próximo viaje",
    sharing: "Compartir",
    sharingDescription:
      "Pon a personas en círculos para que escriban a tu Pim desde el suyo. Solo pueden usar lo que le des a su círculo, y sus mensajes cuentan contra su propio uso, no el tuyo.",
    waitingForYou: "Esperan tu respuesta",
    circles: "Círculos",
    noCircles:
      "Aún no hay círculos. Crea uno, como Familia o Amigos cercanos, y añade personas por su nombre de usuario.",
    circleNamePlaceholder: "Familia, Amigos cercanos…",
    newCircle: "Nuevo círculo",
    circleMembers: "Personas: {count}",
    circlePaused: "En pausa: nadie en él puede escribir a tu Pim",
    shareWithCircle: "Compartir con {circle}",
    deleteCircle: "Eliminar",
    deleteCircleNamed: "Eliminar {circle}",
    membersOf: "Personas en {circle}",
    removeMember: "Quitar a {username} de {circle}",
    usernamePlaceholder: "Su nombre de usuario",
    addTo: "Añadir a alguien a {circle}",
    add: "Añadir",
    whatCircleCanUse: "Lo que {circle} puede usar",
    circlePermissionsDescription:
      "Todo empieza desactivado. Preguntar: apruebas cada solicitud. Activada: la usan sin preguntarte. Estas herramientas actúan en tus cuentas.",
    recentActivity: "Actividad reciente",
    activityRan: "usó",
    activityAsked: "te preguntó",
    activityRefused: "rechazado",
    guestAsked: "{username} ({circle}) pregunta",
    alwaysApproveForCircle: "Aprobar siempre para {circle}",
    memoryTool: "Memoria",
    memoryToolDescription:
      "Lo que tu Pim recuerda de ti: pueden leerlo y buscar en ello, nunca cambiarlo.",
    toolChangedCircle:
      "La app la cambió desde que la permitiste, así que está desactivada para este círculo hasta que elijas de nuevo.",
    sharedWithYou: "Compartidos contigo",
    visitEmptyTitle: "Escribe al Pim de {username}",
    visitEmptyHint:
      "Responde por {username}, con lo que te comparte. Lo que quiera aprobar le llega primero.",
    messageVisit: "Escribe al Pim de {username}…",
    visitPim: "Pim de {username}",
    visitUnavailable: "Ya no se comparte",
    visitBanner:
      "Estás escribiendo al Pim de {username}. Actúa para {username}, dentro de lo que te permite. Tus mensajes usan tu propio uso.",
    toolPermissions: "Permisos de herramientas",
    toolPermissionsDescription:
      "Lo que Pim puede hacer con cada herramienta. Desactivada: Pim no puede usarla. Preguntar: Pim espera tu aprobación. Activada: Pim la usa sin preguntar.",
    pimTools: "Pim",
    permissionOff: "Desactivada",
    permissionAsk: "Preguntar",
    permissionOn: "Activada",
    permissionFor: "Permiso para {tool}",
    useDefaultPermission: "Volver al valor predeterminado de {tool}",
    readOnlyTool: "Solo lectura",
    toolChanged:
      "La app la cambió desde que elegiste Activada, así que Pim vuelve a preguntar. Elige de nuevo para confiar en la nueva versión.",
    toolCount: "Herramientas: {count}",
    awaitingApproval: "Espera tu aprobación",
    approved: "Aprobado",
    arguments: "Argumentos",
    cancelRename: "Cancelar cambio de nombre",
    chatNotFound: "Este chat no existe.",
    chatOptions: "Opciones del chat",
    chats: "Chats",
    close: "Cerrar",
    collapseSidebar: "Contraer barra lateral",
    completed: "Completado",
    connecting: "Conectando…",
    copied: "Copiado",
    couldNotReachPim: "No se pudo contactar a Pim",
    copy: "Copiar",
    copyMessage: "Copiar mensaje",
    deleteChat: "Eliminar",
    confirmDeleteChat: "Confirmar",
    copyResponse: "Copiar respuesta",
    darkTheme: "Tema oscuro",
    denied: "Denegado",
    deny: "Denegar",
    details: "Detalles",
    emptyChatHint:
      "Pregunta lo que quieras, o pide a Pim que recuerde, programe o vigile algo por ti.",
    emptyChatTitle: "¿En qué puedo ayudarte?",
    english: "Inglés",
    failed: "Falló",
    expandSidebar: "Expandir barra lateral",
    language: "Idioma",
    lightTheme: "Tema claro",
    markAllRead: "Marcar todo como leído",
    markRead: "Marcar como leído",
    messagePim: "Escribe a Pim…",
    moreActions: "Más acciones",
    navigation: "Navegación",
    newChat: "Nuevo chat",
    noChatsMatch: "Ningún chat coincide con la búsqueda.",
    noChatsYet: "Aún no hay chats.",
    noNotifications: "Aún no hay notificaciones.",
    notifications: "Notificaciones",
    notificationsDescription: "Lo que Pim te avisó mientras no estabas.",
    pushNotifications: "Notificaciones push",
    pushDescription:
      "Recibe las notificaciones de Pim en este dispositivo, incluso con la app cerrada.",
    pushBlocked:
      "Las notificaciones están bloqueadas para este sitio. Permítelas en los ajustes de tu navegador.",
    pushUnsupported:
      "Este navegador no puede recibir notificaciones push. En un iPhone o iPad, primero agrega Pim a tu pantalla de inicio.",
    older: "Anteriores",
    openChat: "Abrir chat",
    openSidebar: "Abrir barra lateral",
    pending: "Pendiente",
    pimCanMakeMistakes:
      "Pim puede cometer errores. Verifica la información importante.",
    preferences: "Preferencias",
    previous30Days: "Últimos 30 días",
    previous7Days: "Últimos 7 días",
    queuedMessages: "Mensajes en cola: {count}",
    reload: "Recargar",
    rename: "Cambiar nombre",
    result: "Resultado",
    retryingAfterError: "Reintentando tras un error del modelo…",
    review: "Revisar",
    running: "En ejecución",
    saveName: "Guardar nombre",
    searchChats: "Buscar chats",
    sendMessage: "Enviar mensaje",
    showReasoning: "Mostrar razonamiento",
    signInExpired: "Tu sesión expiró",
    spanish: "Español",
    startNewChat: "Iniciar un nuevo chat",
    stopGenerating: "Detener generación",
    systemTheme: "Tema del sistema",
    theme: "Tema",
    thinking: "Pensando...",
    thoughtForSeconds: "Razonó durante {duration} segundo{suffix}",
    thoughtProcess: "Proceso de razonamiento",
    today: "Hoy",
    tryAgain: "Reintentar",
    uploadFiles: "Subir archivos",
    view: "Ver",
    working: "Trabajando",
    yesterday: "Ayer",
    cancel: "Cancelar",
    chatGPTPlanPitch:
      "Usa los modelos de OpenAI, como GPT-6.1 Sol, con el uso incluido en tu plan ChatGPT Plus o Pro. Cuando no estás conectado, Pim usa su modelo predeterminado en Workers AI.",
    chatGPTWhyPaste:
      "El inicio de sesión de OpenAI para apps de código abierto solo puede devolverte a una dirección en tu propio dispositivo (127.0.0.1), que Pim no puede recibir desde internet. Por eso llevas tú esa dirección a Pim, esta única vez.",
    chatGPTStepApprove:
      "En la nueva pestaña, inicia sesión en ChatGPT y aprueba a Pim.",
    chatGPTStepCopy:
      "La pestaña termina en una página de 127.0.0.1 que no carga. Es normal. Copia la dirección completa de la barra de direcciones.",
    chatGPTStepPaste:
      "Pégala abajo, aquí en tu propio Pim, antes de 15 minutos. Contiene un código de un solo uso que completa el inicio de sesión, así que no la pegues en ningún otro lugar.",
    chatGPTAfterPaste:
      "Después, Pim normalmente mantiene la conexión por su cuenta. Si el acceso vence o se revoca en ChatGPT, vuelve a conectarte de la misma forma.",
    connect: "Conectar",
    connectForMoreModels:
      "Conecta tu plan de ChatGPT para elegir los modelos de OpenAI.",
    connectedAs:
      "Conectado como {email}. Las solicitudes de Pim a modelos de OpenAI usan tu plan.",
    continueWithChatGPT: "Continuar con ChatGPT",
    couldNotListModels: "No se pudieron listar tus modelos de ChatGPT: {error}",
    disconnect: "Desconectar",
    gotIt: "Entendido",
    manageUsage: "Administrar uso",
    modelUsageLimit:
      "Pim agotó su asignación de ChatGPT, así que no pudo responder. Es el límite de uso de tu plan o el límite propio de Pim en Límites de apps, que puedes aumentar. Ambos se restablecen solos; la página de uso de ChatGPT muestra cuándo. Mientras tanto, puedes cambiar Pim a su modelo de Workers AI en Configuración.",
    modelQuota:
      "La cuota diaria de uso de Pim se agotó, así que no pudo responder. Se restablece a medianoche UTC.",
    modelSignIn:
      "Pim no pudo usar tu conexión con ChatGPT, así que no pudo responder. Vuelve a conectar ChatGPT en Configuración.",
    modelTooLong:
      "Este chat es demasiado largo para el modelo, así que Pim no pudo responder. Empieza un chat nuevo.",
    modelBusy:
      "El proveedor del modelo está ocupado o no responde, así que Pim no pudo responder. Inténtalo de nuevo en un momento.",
    modelOther:
      "El modelo no pudo responder. Inténtalo de nuevo o cambia de modelo en Configuración.",
    notAnswered: "Sin respuesta: {reason}",
    taskFailed:
      "Algo salió mal, así que Pim no pudo terminar. Inténtalo de nuevo.",
    model: "Modelo",
    modelChanged: "Pim ahora usa {model}",
    pasteAddress: "Dirección a la que llegó el navegador",
    runsOnWorkersAI: "Funciona con Workers AI",
    tryItModel: "Modelo de prueba: gratis en Workers AI, no para uso real",
    settings: "Configuración",
    artifacts: "Artefactos",
    artifactsDescription:
      "Documentos y páginas que Pim hizo para ti, con todas sus versiones. Se guardan hasta que los borres.",
    noArtifacts:
      "Aún no hay ninguno. Pídele a Pim una página, una herramienta o un documento y aparecerá aquí.",
    allArtifacts: "Todos los artefactos",
    artifactSummary: "{kind} · versión {version} · {size}",
    artifactVersion: "Versión {version}",
    artifactVersionOption: "Versión {version} · {date}",
    artifactVersionRestoredOption: "Versión {version} (de la {from}) · {date}",
    artifactVersionDetails: "Versión {version} de {latest} · {size} · {sha}",
    artifactHistory: "Versión",
    artifactPreview: "Vista previa",
    artifactSource: "Código",
    artifactRestore: "Restaurar la versión {version}",
    artifactRestored: "La versión {from} se restauró como versión {version}",
    artifactDelete: "Borrar artefacto",
    artifactDeleteConfirm:
      '¿Borrar "{title}" y sus {versions} versiones? Los chats donde Pim lo hizo siguen mostrando lo que escribió allí hasta que borres esos chats.',
    artifactDeleted: "Este artefacto se borró.",
    artifactVersionMissing: "Este artefacto no tiene la versión {version}.",
    artifactLatest: "Abrir la última, versión {version}",
    artifactDeletedToast: "Artefacto borrado",
    artifactCaution:
      "Hecho por Pim. Se ejecuta en un espacio aislado, separado de tu cuenta, pero aun así podría enviar lo que muestra, o lo que escribas en él, a otro sitio. No escribas contraseñas ni códigos.",
    artifactNavigated:
      "Este artefacto intentó abrir otra página, así que Pim dejó de mostrarlo. Lo que pusiera en la dirección de esa página puede haberse enviado.",
    artifactShowAgain: "Mostrarlo de nuevo",
    loading: "Cargando…",
    open: "Abrir",
    settingsDescription:
      "El modelo con el que funciona Pim y las cuentas que usa.",
    useYourChatGPTPlan: "Usa tu plan de ChatGPT",
    usesChatGPTPlan: "Usa tu plan de ChatGPT",
    usingChatGPTPlan: "Usando el plan de ChatGPT",
    usingYourPlanBody:
      "Las solicitudes de Pim a modelos de OpenAI ahora usan tu plan de ChatGPT. Puedes revisar y limitar el uso de Pim en la configuración de ChatGPT.",
    usingYourPlanTitle: "Estás usando tu plan de ChatGPT",
    yourAccount: "tu cuenta",
    addPasskey: "Agregar una llave de acceso",
    createPasskey: "Crear llave de acceso",
    passkeyAdded: "Llave de acceso agregada",
    passkeyDates: "Agregada {created} · Último uso {used}",
    passkeys: "Llaves de acceso",
    passkeysDescription:
      "Las llaves de acceso inician tu sesión en Pim. Quitar una cierra la sesión de los navegadores que inició.",
    removeCurrentPasskey:
      "Este navegador inició sesión con ella, así que quitarla cierra tu sesión.",
    removePasskey: "Quitar {name}",
    signInBody:
      "Usa la llave de acceso de este dispositivo o la de tu teléfono.",
    signInTitle: "Inicia sesión en Pim",
    signInWithPasskey: "Iniciar sesión con una llave de acceso",
    signOut: "Cerrar sesión",
    thisBrowser: "Este navegador",
    createPasskeyBody:
      "Este enlace de configuración añade una llave de acceso a tu cuenta, una sola vez. Tu dispositivo te pedirá tu cara, huella o PIN.",
    createPasskeyTitle: "Crea tu llave de acceso",
    backToSignIn: "Volver a iniciar sesión",
    getSetupLinkBody:
      "Un enlace de configuración añade una llave de acceso a la cuenta de quien administra este Pim. Pim acaba de escribir uno en sus registros de tu cuenta de Cloudflare, donde solo tú puedes leerlo.",
    getSetupLinkTitle: "Obtén un enlace de configuración",
    lostPasskey: "¿Perdiste tu llave de acceso?",
    openCloudflareDashboard: "Abrir el panel de Cloudflare",
    setUpBody:
      "Nadie ha configurado este Pim todavía. Cualquiera puede hacerlo desde esta página solo en los 15 minutos después de desplegarlo, así que ahora hace falta un enlace de configuración. Pim acaba de escribir uno en sus registros de tu cuenta de Cloudflare, donde solo tú puedes leerlo.",
    claimBody:
      "Eres la primera persona aquí, así que tú administrarás este Pim: invitas a otros y los ayudas a volver si pierden todas sus llaves de acceso. Elige tu nombre de usuario y luego crea una llave de acceso en este dispositivo.",
    setUpTitle: "Configura Pim",
    setupLinkWritten:
      "Enlace escrito en los registros. Funciona una vez, durante una hora.",
    setupStepDashboard:
      "En el panel de Cloudflare, abre Workers & Pages, luego tu Worker de Pim y luego Observability.",
    setupStepOpen:
      "Busca el registro que empieza con “Pim setup link” y abre su enlace en el dispositivo con el que quieres iniciar sesión.",
    writeLinkAgain: "Escribir el enlace otra vez",
    writingSetupLink:
      "Escribiendo un enlace de configuración en los registros…",
    approvedNoAnswer: "Aprobada: sin respuesta a tiempo",
    deniedNoAnswer: "Rechazada: sin respuesta a tiempo",
    recoveryCodeTitle: "Usa un código de recuperación",
    recoveryCodeBody:
      "Escribe tu nombre de usuario y uno de los códigos de recuperación que guardaste al unirte. Añade una llave de acceso en este dispositivo y funciona una sola vez.",
    recoveryCode: "Código de recuperación",
    registerTitle: "Únete a este Pim",
    registerBody:
      "Un agente personal que recuerda lo que te importa, sigue trabajando mientras no estás y pregunta antes de actuar. Elige el nombre de usuario con el que te conocerán aquí.",
    registrationClosed: "Este Pim no está aceptando personas nuevas por ahora.",
    username: "Nombre de usuario",
    usernameHint: "Letras minúsculas, dígitos y guiones.",
    usernameAvailable: "{username} está disponible",
    inviteCode: "Código de invitación",
    registerFootnote:
      "Después guardarás tus códigos de recuperación y crearás una llave de acceso en este dispositivo. No hay contraseña.",
    recoveryCodesFileHeader:
      "Códigos de recuperación de {username} en {host}. Cada uno añade una llave de acceso una vez.",
    saveRecoveryCodesTitle: "Guarda tus códigos de recuperación",
    saveRecoveryCodesBody:
      "Si pierdes tu clave de acceso, uno de estos te deja volver a entrar. Cada uno funciona una vez y no se mostrarán de nuevo.",
    recoveryCodes: "Códigos de recuperación",
    download: "Descargar",
    savedRecoveryCodes:
      "Guardé mis códigos de recuperación en un lugar seguro.",
    exportData: "Exportar mis datos",
    accountUsageToday:
      "Lo que usaste hoy. Los límites se reinician a medianoche UTC.",
    usageTokens: "Tokens",
    usageRuns: "Ejecuciones",
    usageModelRequests: "Solicitudes al modelo",
    usedOf: "{used} de {limit}",
    planTokensToday:
      "Más {tokens} tokens de tu plan de ChatGPT, que no cuentan aquí.",
    recoveryCodesLeft: "Códigos de recuperación restantes: {count}",
    newRecoveryCodes: "Nuevos códigos de recuperación",
    newRecoveryCodesBody:
      "Tus códigos anteriores ya no funcionan. Guarda estos ahora: no se mostrarán de nuevo.",
    settingsSaved: "Guardado",
    timeZone: "Zona horaria",
    approvalPolicy: "Cuando no respondes",
    approvalPolicyDescription:
      "Cuando Pim pregunta antes de actuar y no respondes a tiempo:",
    approvalExplicit: "Rechazarlo",
    approvalExplicitBody:
      "Pim espera 5 minutos y luego no actúa. Nada pasa sin un sí.",
    approvalAuto: "Aprobarlo",
    approvalAutoBody:
      "Pim espera 30 segundos y luego actúa, para que el trabajo en segundo plano nunca se detenga.",
    apiTokens: "Tokens de API",
    apiTokensDescription:
      "Los tokens permiten que apps y scripts usen la API de Pim. Cada uno puede hacer todo lo que tú puedes, salvo gestionar el inicio de sesión.",
    tokenDates: "Creado {created} · Último uso {used}",
    never: "nunca",
    revokeToken: "Revocar {name}",
    tokenShownOnce: "Copia tu nuevo token ahora. No se mostrará de nuevo.",
    tokenName: "Nombre del token",
    tokenNamePlaceholder: "Qué lo usará, como “Teléfono”",
    createToken: "Crear token",
    deleteAccount: "Eliminar cuenta",
    deleteAccountBody:
      "Elimina el Pim de {username}: conversaciones, memorias, metas, apps conectadas y llaves de acceso. No se puede deshacer y el nombre de usuario no volverá a estar disponible.",
    typeUsernameToConfirm: "Escribe {username} para confirmar",
    deleteForever: "Eliminar para siempre",
    deleteAccountButton: "Eliminar mi cuenta…",
    addThisDeviceTitle: "Agrega este dispositivo",
    addingTo: "Agregando este dispositivo a",
    passkeyAlreadyHere:
      "Este dispositivo ya tiene una llave de acceso para este Pim, así que no necesita otra. Inicia sesión con ella.",
    signInWithThisPasskey: "Iniciar sesión con mi llave de acceso",
    addDeviceCancelFailed:
      "No se pudo terminar el enlace ({error}), así que podría seguir funcionando hasta que venza. Inténtalo de nuevo.",
    addThisDeviceBody:
      "Tu Pim envió este enlace desde un dispositivo donde tienes sesión iniciada. Crea aquí una llave de acceso y este dispositivo podrá iniciar sesión por su cuenta desde ahora.",
    addThisDeviceNote:
      "El enlace funciona una vez, durante 10 minutos. Tus otros dispositivos y llaves de acceso no cambian.",
    newDeviceTitle: "¿Te registraste en otro dispositivo?",
    newDeviceBody:
      "Una llave de acceso vive en el dispositivo que la creó, a menos que tu gestor de contraseñas la sincronice aquí. En un dispositivo con sesión iniciada, abre Configuración → Llaves de acceso → Agregar otro dispositivo y escanea el código. ¿No tienes otro dispositivo? Usa un código de recuperación.",
    addDeviceTitle: "Agregar otro dispositivo",
    addDeviceBody:
      "Inicia sesión en tu teléfono u otra computadora: crea su propia llave de acceso con un enlace de un solo uso.",
    addDeviceButton: "Agregar otro dispositivo",
    addDeviceQr: "Código QR con un enlace que agrega otro dispositivo",
    addDeviceStepScan:
      "En el otro dispositivo, escanea este código con la cámara o abre el enlace.",
    addDeviceStepPasskey: "Toca Crear llave de acceso allí.",
    addDeviceExpires:
      "Funciona una vez, hasta las {time}. Cualquiera con este enlace puede agregar un dispositivo, así que ábrelo solo tú.",
    addDeviceExpired: "Ese enlace venció. Crea uno nuevo.",
    copyLink: "Copiar enlace",
    done: "Listo",
    accountClosedTitle: "Tu cuenta está cerrada",
    accountClosedBody:
      "Ya nadie puede usarla, pero el borrado de sus datos aún no terminó. Pim lo sigue intentando hasta borrarlo todo; no tienes que hacer nada.",
    adminBadge: "Admin",
    you: "tú",
    leave: "Salir",
    members: "Personas en este Pim",
    membersDescription:
      "Todas las personas que se unieron. Invita a alguien con un enlace que funciona una vez. Para quien perdió todas sus llaves de acceso y códigos de recuperación, crea un enlace de configuración.",
    inviteSomeone: "Invitar a alguien",
    inviteLinkNote:
      "Funciona una vez. Cualquiera que lo tenga puede unirse, así que envíalo solo a esa persona.",
    setupLinkFor:
      "Añade una llave de acceso a la cuenta de @{username}, una vez, dentro de una hora. Envíalo solo a esa persona.",
    setupLinkAction: "Enlace de configuración para @{username}",
    memberPending: "Aún no crea una llave de acceso",
    memberSuspended: "Suspendida",
    memberDeleting: "Borrándose",
    suspendMember: "Suspender a @{username}",
    restoreMember: "Restaurar a @{username}",
    deleteMember: "Eliminar a @{username}",
    becomeAdmin: "Configurar este Pim",
    createAccount: "Crear mi cuenta",
    firstPasskeyNote:
      "Tu dispositivo te pedirá tu cara, huella o PIN. Añade tus otros dispositivos después, desde Ajustes.",
    notMyPim: "Este no es mi Pim",
    newHere: "¿Eres nuevo aquí?",
    joinByInvite:
      "¿Eres nuevo aquí? Pide un enlace de invitación a quien administra este Pim.",
    adminLostPasskey:
      "¿Administras este Pim y perdiste todas tus llaves de acceso?",
    getSetupLinkFromLogs: "Obtén un enlace de configuración de los registros",
  },
} as const;

export type TranslationKey = keyof (typeof translations)["en"];
type Variables = Record<string, string | number>;

function supportedLocale(value: string | null | undefined): Locale | null {
  const language = value?.toLowerCase().split("-")[0];
  return locales.find((locale) => locale === language) ?? null;
}

function initialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  return (
    supportedLocale(window.localStorage.getItem(STORAGE_KEY)) ??
    supportedLocale(window.navigator.language) ??
    "en"
  );
}

function interpolate(message: string, values?: Variables): string {
  return message.replace(/\{(\w+)\}/g, (_, name: string) =>
    values?.[name] === undefined ? `{${name}}` : String(values[name]),
  );
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, values?: Variables) => string;
  formatDate: (date: Date, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

const defaultI18n: I18nContextValue = {
  locale: "en",
  setLocale: () => {},
  t: (key, values) => interpolate(translations.en[key], values),
  formatDate: (date, options) =>
    new Intl.DateTimeFormat("en", options).format(date),
  formatNumber: (number, options) =>
    new Intl.NumberFormat("en", options).format(number),
};

const I18nContext = createContext<I18nContextValue>(defaultI18n);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = (nextLocale: Locale) => {
    setLocaleState(nextLocale);
    window.localStorage.setItem(STORAGE_KEY, nextLocale);
  };

  const value: I18nContextValue = {
    locale,
    setLocale,
    t: (key, values) => interpolate(translations[locale][key], values),
    formatDate: (date, options) =>
      new Intl.DateTimeFormat(locale, options).format(date),
    formatNumber: (number, options) =>
      new Intl.NumberFormat(locale, options).format(number),
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function LanguageSelect({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className={className}>
      <span className="sr-only">{t("language")}</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        className="h-8 rounded-md border bg-transparent px-2 text-sm"
      >
        <option value="en">{t("english")}</option>
        <option value="es">{t("spanish")}</option>
      </select>
    </label>
  );
}
