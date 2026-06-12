.PHONY: dev test deploy

dev:
	npm run dev

test:
	npm test

deploy:
	npm test && npm run deploy
