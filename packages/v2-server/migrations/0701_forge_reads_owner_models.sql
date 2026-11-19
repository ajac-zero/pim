-- Coding threads on pi run on the person's own models, as their chats do: Forge's worker reads the owner's providers (their own and what the admin shared, with the sealed keys) and their
-- ChatGPT plan through the same definer functions the Runner uses, each naming one owner. The role still reads no table of the application directly.
GRANT EXECUTE ON FUNCTION pim_app.runner_providers(text), pim_app.shared_providers(boolean), pim_app.runner_chatgpt(text), pim_app.runner_chatgpt_lock(text), pim_app.runner_chatgpt_put(text, text) TO pim_forge;
