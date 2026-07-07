export function read(prompt, opts = {}) {
  const maxDigits = opts.maxDigits || 1;
  return `read=${prompt},no,${maxDigits},,,`;
}

export function message(text) {
  return `id_list_message=${text}`;
}

export function hangup(text) {
  return text ? `${message(text)}\ngo_to_folder=hangup` : 'go_to_folder=hangup';
}
