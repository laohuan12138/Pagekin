FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
RUN mkdir -p /data && chown node:node /data

ENV SYNC_HOST=0.0.0.0 \
    SYNC_PORT=8787 \
    SYNC_DATA_DIR=/data

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SYNC_PORT||8787)+'/health',{headers:{authorization:'Bearer '+process.env.SYNC_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
