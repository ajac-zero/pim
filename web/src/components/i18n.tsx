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
    alwaysApproved: "Always approved",
    alwaysApprovedDescription:
      "Pim uses these tools without asking first. Remove one to be asked again.",
    noAlwaysApproved:
      "None yet. Choose Always approve on a request to stop being asked about that tool.",
    stopAlwaysApproving: "Ask before {tool} again",
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
    retryingAfterError: "Retrying after an error: {error}",
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
    model: "Model",
    modelChanged: "Pim now uses {model}",
    pasteAddress: "Address the browser landed on",
    runsOnWorkersAI: "Runs on Workers AI",
    settings: "Settings",
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
      "This setup link adds a passkey to your Pim, once. Your device will ask for your face, fingerprint, or PIN.",
    createPasskeyTitle: "Create your passkey",
    backToSignIn: "Back to sign in",
    getSetupLinkBody:
      "A setup link adds a new passkey. Pim just wrote one to its logs in your Cloudflare account, where only you can read it.",
    getSetupLinkTitle: "Get a setup link",
    lostPasskey: "Lost your passkey?",
    openCloudflareDashboard: "Open the Cloudflare dashboard",
    setUpBody:
      "Pim signs you in with a passkey. This page makes the first one by itself only in the 15 minutes after deploying, so now it takes a setup link. Pim just wrote one to its logs in your Cloudflare account, where only you can read it.",
    claimBody:
      "Pim signs you in with a passkey: your face, fingerprint, or PIN on this device. Create the one you'll use.",
    claimNote:
      "Only Pim's first passkey is made this way, in the 15 minutes after deploying. Add more later from Settings.",
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
    finishSetUpTitle: "Finish setting up",
    finishSetUpBody:
      "Open the setup link from when you registered, or enter one of your recovery codes to create your passkey.",
    recoveryCodeTitle: "Use a recovery code",
    recoveryCodeBody:
      "Enter one of the recovery codes you saved when you registered. It adds a passkey on this device, and works once.",
    recoveryCode: "Recovery code",
    registerTitle: "Get your own Pimling",
    registerBody:
      "A personal agent that remembers what matters to you, keeps working while you're away, and asks before acting. It lives at your own address.",
    registrationClosed: "Registration is closed for now. Check back soon.",
    username: "Username",
    usernameHint: "Lowercase letters, digits, and hyphens.",
    usernameAvailable: "{host} is available",
    inviteCode: "Invite code",
    createMyPimling: "Create my Pimling",
    registerFootnote:
      "Next you'll save recovery codes, then create a passkey on your new Pimling. There's no password.",
    recoveryCodesFileHeader:
      "Recovery codes for {host}. Each adds a passkey once.",
    saveRecoveryCodesTitle: "Save your recovery codes",
    saveRecoveryCodesBody:
      "If you lose your passkey, one of these gets you back in. Each works once, and they won't be shown again.",
    recoveryCodes: "Recovery codes",
    download: "Download",
    savedRecoveryCodes: "I saved my recovery codes somewhere safe.",
    continueTo: "Continue to {host}",
    setupLinkLasts:
      "There you'll create your passkey. The setup link works once, for a day.",
    exportData: "Export my data",
    accountUsageToday:
      "What your Pimling used today. Limits reset at midnight UTC.",
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
      "Deletes {username}'s Pimling: conversations, memories, goals, connected apps, and passkeys. It can't be undone, and the username won't be available again.",
    typeUsernameToConfirm: "Type {username} to confirm",
    deleteForever: "Delete forever",
    deleteAccountButton: "Delete my account…",
    addThisDeviceTitle: "Add this device",
    addingTo: "Adding this device to",
    notMyPimling: "This isn't my Pimling",
    passkeyAlreadyHere:
      "This device already has a passkey for this Pimling, so it doesn't need another. Sign in with it instead.",
    signInWithThisPasskey: "Sign in with my passkey",
    addDeviceCancelFailed:
      "Couldn't end the link ({error}), so it may still work until it expires. Try again.",
    addThisDeviceBody:
      "Your Pimling sent this link from a device where you're signed in. Create a passkey here, and this device can sign in on its own from now on.",
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
    havePimling: "Already have a Pimling?",
    signInToIt: "Sign in",
    needPimling: "Don't have one yet?",
    createOne: "Create one",
    findPimlingTitle: "Sign in to your Pimling",
    findPimlingBody:
      "Enter your username to go to your Pimling, then sign in with your passkey.",
    goToMyPimling: "Go to my Pimling",
    accountClosedTitle: "Your account is closed",
    accountClosedBody:
      "Nobody can use it anymore, but erasing its data hasn't finished yet. Pimling keeps retrying until everything is erased; you don't need to do anything.",
    leavePimling: "Leave",
  },
  es: {
    approvalRequested: "Pim necesita tu aprobación",
    approve: "Aprobar",
    alwaysApprove: "Aprobar siempre",
    moreApprovalOptions: "Más opciones de aprobación",
    alwaysApproved: "Aprobadas siempre",
    alwaysApprovedDescription:
      "Pim usa estas herramientas sin preguntar antes. Quita una para que vuelva a preguntarte.",
    noAlwaysApproved:
      "Ninguna todavía. Elige Aprobar siempre en una solicitud para que no vuelva a preguntarte por esa herramienta.",
    stopAlwaysApproving: "Volver a preguntar antes de {tool}",
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
    retryingAfterError: "Reintentando tras un error: {error}",
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
    model: "Modelo",
    modelChanged: "Pim ahora usa {model}",
    pasteAddress: "Dirección a la que llegó el navegador",
    runsOnWorkersAI: "Funciona con Workers AI",
    settings: "Configuración",
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
      "Este enlace de configuración agrega una llave de acceso a tu Pim, una sola vez. Tu dispositivo te pedirá tu rostro, huella o PIN.",
    createPasskeyTitle: "Crea tu llave de acceso",
    backToSignIn: "Volver a iniciar sesión",
    getSetupLinkBody:
      "Un enlace de configuración agrega una nueva llave de acceso. Pim acaba de escribir uno en sus registros de tu cuenta de Cloudflare, donde solo tú puedes leerlo.",
    getSetupLinkTitle: "Obtén un enlace de configuración",
    lostPasskey: "¿Perdiste tu llave de acceso?",
    openCloudflareDashboard: "Abrir el panel de Cloudflare",
    setUpBody:
      "Pim inicia tu sesión con una llave de acceso. Esta página crea la primera por sí sola solo en los 15 minutos después de desplegar, así que ahora hace falta un enlace de configuración. Pim acaba de escribir uno en sus registros de tu cuenta de Cloudflare, donde solo tú puedes leerlo.",
    claimBody:
      "Pim inicia tu sesión con una llave de acceso: tu rostro, huella o PIN en este dispositivo. Crea la que vas a usar.",
    claimNote:
      "Solo la primera llave de acceso de Pim se crea así, en los 15 minutos después de desplegar. Agrega más luego desde Configuración.",
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
    finishSetUpTitle: "Termina la configuración",
    finishSetUpBody:
      "Abre el enlace de configuración de tu registro o escribe uno de tus códigos de recuperación para crear tu clave de acceso.",
    recoveryCodeTitle: "Usa un código de recuperación",
    recoveryCodeBody:
      "Escribe uno de los códigos de recuperación que guardaste al registrarte. Añade una clave de acceso en este dispositivo y funciona una sola vez.",
    recoveryCode: "Código de recuperación",
    registerTitle: "Consigue tu propio Pimling",
    registerBody:
      "Un agente personal que recuerda lo que te importa, sigue trabajando cuando no estás y pregunta antes de actuar. Vive en tu propia dirección.",
    registrationClosed: "El registro está cerrado por ahora. Vuelve pronto.",
    username: "Nombre de usuario",
    usernameHint: "Letras minúsculas, dígitos y guiones.",
    usernameAvailable: "{host} está disponible",
    inviteCode: "Código de invitación",
    createMyPimling: "Crear mi Pimling",
    registerFootnote:
      "Después guardarás tus códigos de recuperación y crearás una clave de acceso en tu nuevo Pimling. No hay contraseña.",
    recoveryCodesFileHeader:
      "Códigos de recuperación de {host}. Cada uno añade una clave de acceso una vez.",
    saveRecoveryCodesTitle: "Guarda tus códigos de recuperación",
    saveRecoveryCodesBody:
      "Si pierdes tu clave de acceso, uno de estos te deja volver a entrar. Cada uno funciona una vez y no se mostrarán de nuevo.",
    recoveryCodes: "Códigos de recuperación",
    download: "Descargar",
    savedRecoveryCodes:
      "Guardé mis códigos de recuperación en un lugar seguro.",
    continueTo: "Continuar a {host}",
    setupLinkLasts:
      "Allí crearás tu clave de acceso. El enlace de configuración funciona una vez, durante un día.",
    exportData: "Exportar mis datos",
    accountUsageToday:
      "Lo que tu Pimling usó hoy. Los límites se reinician a medianoche UTC.",
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
      "Elimina el Pimling de {username}: conversaciones, memorias, metas, apps conectadas y claves de acceso. No se puede deshacer y el nombre de usuario no volverá a estar disponible.",
    typeUsernameToConfirm: "Escribe {username} para confirmar",
    deleteForever: "Eliminar para siempre",
    deleteAccountButton: "Eliminar mi cuenta…",
    addThisDeviceTitle: "Agrega este dispositivo",
    addingTo: "Agregando este dispositivo a",
    notMyPimling: "Este no es mi Pimling",
    passkeyAlreadyHere:
      "Este dispositivo ya tiene una llave de acceso para este Pimling, así que no necesita otra. Inicia sesión con ella.",
    signInWithThisPasskey: "Iniciar sesión con mi llave de acceso",
    addDeviceCancelFailed:
      "No se pudo terminar el enlace ({error}), así que podría seguir funcionando hasta que venza. Inténtalo de nuevo.",
    addThisDeviceBody:
      "Tu Pimling envió este enlace desde un dispositivo donde tienes sesión iniciada. Crea aquí una llave de acceso y este dispositivo podrá iniciar sesión por su cuenta desde ahora.",
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
    havePimling: "¿Ya tienes un Pimling?",
    signInToIt: "Inicia sesión",
    needPimling: "¿Aún no tienes uno?",
    createOne: "Crea uno",
    findPimlingTitle: "Inicia sesión en tu Pimling",
    findPimlingBody:
      "Escribe tu nombre de usuario para ir a tu Pimling y luego inicia sesión con tu llave de acceso.",
    goToMyPimling: "Ir a mi Pimling",
    accountClosedTitle: "Tu cuenta está cerrada",
    accountClosedBody:
      "Ya nadie puede usarla, pero el borrado de sus datos aún no terminó. Pimling lo sigue intentando hasta borrarlo todo; no tienes que hacer nada.",
    leavePimling: "Salir",
  },
} as const;

type TranslationKey = keyof (typeof translations)["en"];
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
