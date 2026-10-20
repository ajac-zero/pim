# The computers Pim starts on Fly.io for people who don't bring their own (src/fly.ts): Node.js,
# Chromium for the agents' browser, and the tools agents reach for first. Everything on a
# machine stays across restarts, so what's installed later stays too. Build and push it to the
# Fly app the machines go in, then set PIM_FLY_IMAGE to it (see the README's "Computers Pim
# starts"):
#
#   fly apps create pim-computers
#   fly auth docker
#   docker build -t registry.fly.io/pim-computers:latest computer
#   docker push registry.fly.io/pim-computers:latest
#
# It runs pim-computer as fetched from the Pim at each start, so a machine stays in step with the
# Pim that started it; the copy built in is used when the Pim can't be reached.
FROM node:24-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		chromium fonts-liberation fonts-noto-color-emoji \
		bash ca-certificates curl git less openssh-client procps python3 sudo unzip \
	&& rm -rf /var/lib/apt/lists/*

COPY pim-computer.ts /opt/pim/pim-computer.ts

# The person's files are in /root/pim, and the browser's profile in /root/.pim-computer.
ENV PIM_CHROME=/usr/bin/chromium
WORKDIR /root

CMD ["sh", "-c", "curl -fsSL \"$PIM_URL/pim-computer.ts\" -o /opt/pim/pim-computer.next.ts && mv /opt/pim/pim-computer.next.ts /opt/pim/pim-computer.ts; exec node /opt/pim/pim-computer.ts"]
