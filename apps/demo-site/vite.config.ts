// biome-ignore lint/style/noDefaultExport: Vite requires default export
export default {
  base: "/scomp/",
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        inprocess: "inprocess.html",
        "cross-window": "cross-window.html",
        "host-frame": "host-frame.html",
        "client-frame": "client-frame.html",
      },
    },
  },
};
