# An extension is not an image you run. It is an image whose layers are a
# tarball, unpacked over the server's filesystem at container start, leaving one
# script behind for the entrypoint to execute. Nothing here ever runs as a
# container of its own, which is why it has no CMD and no base worth naming.
FROM scratch

COPY install.sh /etc/s2e/extensions/10-kfx.sh
