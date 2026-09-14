import type { APIRoute } from 'astro';
import Papa from 'papaparse';
import { Octokit } from 'octokit';
import fs from 'node:fs/promises';
import path from 'node:path';

export const POST: APIRoute = async ({ request }) => {
  try {
    const formData = await request.formData();
    const token = formData.get('token')?.toString();

    if (!token) {
      return new Response('Missing GitHub PAT', { status: 400 });
    }

    const octokit = new Octokit({ auth: token });
    const repoOwner = 'jonichrishannon-eng';
    const repoName = 'SaftLAN';

    // 1. Fetch produkte.csv from saftladen-showcase
    const csvResponse = await fetch('https://raw.githubusercontent.com/jonichrishannon-eng/saftladen-showcase/main/produkte.csv');
    if (!csvResponse.ok) {
      return new Response('Failed to fetch produkte.csv', { status: 500 });
    }
    const csvText = await csvResponse.text();

    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      delimiter: ';'
    });

    const products = parsed.data as Array<{ ArtNr: string, Name: string, Preis: string }>;

    // Read local overrides
    let overrides: Record<string, string> = {};
    try {
      const overridesStr = await fs.readFile(path.join(process.cwd(), 'src/data/overrides.json'), 'utf-8');
      overrides = JSON.parse(overridesStr);
    } catch (e) {
      console.warn("No overrides found or error reading overrides.json", e);
    }

    const finalProducts = [];

    // Ensure public/images directory exists locally
    const publicImagesPath = path.join(process.cwd(), 'public/images');
    await fs.mkdir(publicImagesPath, { recursive: true }).catch(() => {});

    for (const prod of products) {
      let imageUrl = overrides[prod.ArtNr] || null;

      const localImageName = `${prod.ArtNr}.jpg`;
      const localImagePath = path.join(publicImagesPath, localImageName);

      let imageExistsLocally = false;
      try {
        await fs.access(localImagePath);
        imageExistsLocally = true;
      } catch {
        imageExistsLocally = false;
      }

      if (!imageUrl && !imageExistsLocally) {
        // Search OpenFoodFacts
        console.log(`Searching OpenFoodFacts for: ${prod.Name}`);
        const offResponse = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(prod.Name)}&search_simple=1&action=process&json=1&page_size=1`);

        if (offResponse.ok) {
          const offData = await offResponse.json();
          if (offData.products && offData.products.length > 0) {
            const bestMatch = offData.products[0];
            const foundImageUrl = bestMatch.image_url || bestMatch.image_front_url;

            if (foundImageUrl) {
              console.log(`Found image for ${prod.Name}: ${foundImageUrl}`);
              // Download image
              const imgRes = await fetch(foundImageUrl);
              if (imgRes.ok) {
                const arrayBuffer = await imgRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                // Save locally
                await fs.writeFile(localImagePath, buffer);

                // Upload to GitHub
                try {
                  // Get main branch ref
                  const { data: refData } = await octokit.rest.git.getRef({
                    owner: repoOwner,
                    repo: repoName,
                    ref: 'heads/main'
                  });

                  // Get current commit
                  const { data: commitData } = await octokit.rest.git.getCommit({
                    owner: repoOwner,
                    repo: repoName,
                    commit_sha: refData.object.sha
                  });

                  // Create blob
                  const { data: blobData } = await octokit.rest.git.createBlob({
                    owner: repoOwner,
                    repo: repoName,
                    content: buffer.toString('base64'),
                    encoding: 'base64'
                  });

                  // Create tree
                  const { data: treeData } = await octokit.rest.git.createTree({
                    owner: repoOwner,
                    repo: repoName,
                    base_tree: commitData.tree.sha,
                    tree: [{
                      path: `public/images/${localImageName}`,
                      mode: '100644',
                      type: 'blob',
                      sha: blobData.sha
                    }]
                  });

                  // Create commit
                  const { data: newCommitData } = await octokit.rest.git.createCommit({
                    owner: repoOwner,
                    repo: repoName,
                    message: `Add image for product ${prod.ArtNr} (${prod.Name})`,
                    tree: treeData.sha,
                    parents: [commitData.sha]
                  });

                  // Update ref
                  await octokit.rest.git.updateRef({
                    owner: repoOwner,
                    repo: repoName,
                    ref: 'heads/main',
                    sha: newCommitData.sha
                  });
                  console.log(`Successfully committed image for ${prod.ArtNr}`);
                } catch (ghError) {
                  console.error(`Failed to commit image for ${prod.ArtNr} to GitHub:`, ghError);
                }
              }
            }
          }
        }
      }

      // We assign the final URL. If we just downloaded it, it's /images/ArtNr.jpg
      if (!imageUrl) {
        imageUrl = `/images/${localImageName}`;
      }

      finalProducts.push({
        ...prod,
        image: imageUrl
      });
    }

    // Save products.json locally
    await fs.writeFile(
      path.join(process.cwd(), 'src/data/products.json'),
      JSON.stringify(finalProducts, null, 2)
    );

    // Also try committing products.json to GitHub
    try {
        const fileContent = JSON.stringify(finalProducts, null, 2);

        // Find existing file sha if it exists
        let fileSha = undefined;
        try {
            const { data: fileData } = await octokit.rest.repos.getContent({
                owner: repoOwner,
                repo: repoName,
                path: 'src/data/products.json'
            });
            if (!Array.isArray(fileData)) {
                fileSha = fileData.sha;
            }
        } catch (e) {
            // File might not exist yet
        }

        await octokit.rest.repos.createOrUpdateFileContents({
            owner: repoOwner,
            repo: repoName,
            path: 'src/data/products.json',
            message: 'Update products.json from sync',
            content: Buffer.from(fileContent).toString('base64'),
            sha: fileSha
        });
    } catch (e) {
        console.error("Failed to commit products.json:", e);
    }

    return new Response(
      `<div id="sync-result" class="p-4 bg-green-500/20 text-green-300 rounded border border-green-500/50">Sync completed successfully! Found ${finalProducts.length} products.</div>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  } catch (err: any) {
    console.error(err);
    return new Response(
      `<div id="sync-result" class="p-4 bg-red-500/20 text-red-300 rounded border border-red-500/50">Error: ${err.message}</div>`,
      { headers: { 'Content-Type': 'text/html' }, status: 500 }
    );
  }
};