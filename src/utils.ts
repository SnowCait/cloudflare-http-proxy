export function wantsJson(accept: string | undefined): boolean {
  return (
    accept
      ?.split(",")
      .some((type) => type.trim().split(";")[0].trim() === "application/json") ??
    false
  );
}
