/** `.md` files are bundled as plain text (esbuild `loader: {'.md': 'text'}`) — see `src/starterKit.ts`. */
declare module '*.md' {
	const content: string;
	export default content;
}
