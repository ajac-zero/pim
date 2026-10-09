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
      "Run Pim on OpenAI's models, such as GPT-6.1 Sol, with usage included in your ChatGPT Plus or Pro plan. Workers AI stays free and is used when you're not connected.",
    chatGPTStepApprove: "Sign in in the new tab and approve Pim.",
    chatGPTStepCopy:
      "The tab ends on a page at 127.0.0.1 that doesn't load. That's expected: copy the whole address from its address bar and paste it here.",
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
    runsOnWorkersAI: "Workers AI, on your Cloudflare account",
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
  },
  es: {
    approvalRequested: "Pim necesita tu aprobación",
    approve: "Aprobar",
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
      "Usa los modelos de OpenAI, como GPT-6.1 Sol, con el uso incluido en tu plan ChatGPT Plus o Pro. Workers AI sigue siendo gratis y se usa cuando no estás conectado.",
    chatGPTStepApprove: "Inicia sesión en la nueva pestaña y aprueba a Pim.",
    chatGPTStepCopy:
      "La pestaña termina en una página de 127.0.0.1 que no carga. Es normal: copia la dirección completa de la barra de direcciones y pégala aquí.",
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
    runsOnWorkersAI: "Workers AI, en tu cuenta de Cloudflare",
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
